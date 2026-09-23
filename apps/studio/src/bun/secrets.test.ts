import { afterAll, expect, test } from "bun:test";
import { createCipheriv, randomBytes } from "crypto";
import { eq } from "drizzle-orm";

import { db } from "./db";
import { settings as settingsTable } from "./db/schema";
import {
  ENCRYPTED_SETTINGS_KEYS,
  ensureSettingsEncrypted,
  getAllSettings,
  getSetting,
  invalidateSettingsCache,
  updateSettings,
} from "./db/settings";
import { decryptSecret, encryptSecret, isEncryptedSecret, tryDecryptSecret } from "./secrets";
import { readAppLogsInMemory } from "./app-log";

// ---------------------------------------------------------------------------
// 密钥落盘加密（FUT-02）：模型云/网关的 Key 不再明文躺 SQLite。
//   1. 密文往返 + 旧明文透传（老库兼容）；
//   2. settings 透明层：落盘密文、读取明文，消费方零改动；
//   3. EMPTY 哨兵 / 空值不制造密文；
//   4. 历史明文一次性迁移（幂等）；
//   5. **解不开的密文只降级、不抛** —— 恢复别处机器的备份（归档不含 secrets.key）
//      之后，读设置是启动路上的第一个调用，抛出去等于引导页永远走不完。
// ---------------------------------------------------------------------------
// 直接遍历实现里的名单：以后再加一个密钥键，这一组断言自动覆盖到它，
// 不会出现「加进 ENCRYPTED_KEYS 但没人测」的空档。
const KEYS = ENCRYPTED_SETTINGS_KEYS;
const original = Object.fromEntries(KEYS.map((k) => [k, getSetting(k)]));

/** 直接读库里的原始值（绕过 settings 的透明解密），用于断言"盘上到底是明文还是密文"。 */
function rawValue(key: string): string | undefined {
  return db.select().from(settingsTable).where(eq(settingsTable.key, key)).get()?.value;
}

/** 写一份「历史明文」进库，模拟升级前的老数据。 */
function seedPlaintext(key: string, value: string): void {
  db.insert(settingsTable)
    .values({ key, value })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value } })
    .run();
}

/**
 * 用**另一把钥匙**加密：模拟"从别的机器恢复进来的密文" —— 格式完全合法（v1: 前缀、
 * iv/tag/密文齐全），只有本机的 secrets.key 解不开。这正是一次跨机恢复之后的盘上状态。
 */
function foreignCiphertext(plain: string): string {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64")}`;
}

afterAll(() => {
  updateSettings({ ...original });
});

test("密文往返：v1: 前缀、可解回；旧明文透传；空串不加密", () => {
  const ct = encryptSecret("sk-abc-123");
  expect(ct.startsWith("v1:")).toBe(true);
  expect(isEncryptedSecret(ct)).toBe(true);
  expect(decryptSecret(ct)).toBe("sk-abc-123");
  // 老库里的明文没有 v1: 前缀 —— 读取侧必须原样透传，否则升级即坏。
  expect(isEncryptedSecret("legacy-plain")).toBe(false);
  expect(decryptSecret("legacy-plain")).toBe("legacy-plain");
  expect(encryptSecret("")).toBe("");
});

test("settings 透明加密：落盘是密文，读取是明文", () => {
  for (const key of KEYS) {
    updateSettings({ [key]: "sk-secret-value" });
    invalidateSettingsCache();
    const stored = rawValue(key);
    expect(isEncryptedSecret(stored!)).toBe(true);
    expect(stored).not.toContain("sk-secret-value");
    expect(getSetting(key)).toBe("sk-secret-value");
    expect(getAllSettings()[key]).toBe("sk-secret-value");
  }
});

test("EMPTY 哨兵与空值不制造密文", () => {
  updateSettings({ VLLM_API_KEY: "EMPTY", GATEWAY_API_KEY: "" });
  invalidateSettingsCache();
  expect(rawValue("VLLM_API_KEY")).toBe("EMPTY");
  expect(getSetting("VLLM_API_KEY")).toBe("EMPTY");
  expect(rawValue("GATEWAY_API_KEY")).toBe("");
  expect(getSetting("GATEWAY_API_KEY")).toBe("");
});

test("历史明文迁移：ensureSettingsEncrypted 翻成密文且仍可读（幂等）", () => {
  for (const key of KEYS) seedPlaintext(key, "plain-legacy-key");
  invalidateSettingsCache();
  expect(isEncryptedSecret(rawValue("VLLM_API_KEY")!)).toBe(false);

  ensureSettingsEncrypted();

  for (const key of KEYS) expect(isEncryptedSecret(rawValue(key)!)).toBe(true);
  invalidateSettingsCache();
  expect(getSetting("VLLM_API_KEY")).toBe("plain-legacy-key");
  expect(getSetting("GATEWAY_API_KEY")).toBe("plain-legacy-key");

  // 再跑一次不得重复加密（密文再加密会解不出原文）。
  const once = rawValue("VLLM_API_KEY");
  ensureSettingsEncrypted();
  expect(rawValue("VLLM_API_KEY")).toBe(once!);
  invalidateSettingsCache();
  expect(getSetting("VLLM_API_KEY")).toBe("plain-legacy-key");
});

test("tryDecryptSecret：解不开给结果对象，不抛；明文与空值照旧透传", () => {
  const ok = tryDecryptSecret(encryptSecret("sk-ok"));
  expect(ok).toEqual({ ok: true, value: "sk-ok" });
  expect(tryDecryptSecret("legacy-plain")).toEqual({ ok: true, value: "legacy-plain" });
  expect(tryDecryptSecret("")).toEqual({ ok: true, value: "" });

  const failed = tryDecryptSecret(foreignCiphertext("sk-elsewhere"));
  expect(failed.ok).toBe(false);
  // 会抛的那一份仍然要抛（写路径不该把坏密文当明文用出去）
  expect(() => decryptSecret(foreignCiphertext("sk-elsewhere"))).toThrow();
});

test("恢复别处机器的备份：解不开的密文按空值处理，读设置不抛且留日志", () => {
  seedPlaintext("VLLM_API_KEY", foreignCiphertext("sk-from-another-machine"));
  seedPlaintext("GATEWAY_API_KEY", encryptSecret("sk-mine"));
  invalidateSettingsCache();

  // 这是启动路上的第一个调用（getSettings RPC 直接调它）：解不开也不能抛，
  // 否则整个引导页走不完、进不去主界面。
  expect(() => getAllSettings()).not.toThrow();
  expect(getAllSettings().VLLM_API_KEY).toBe(""); // 解不开 → 语义是"本机没有这个凭据"
  expect(getSetting("VLLM_API_KEY")).toBe("");
  // 别的键（包括本机自己加密的那些）不受影响
  expect(getAllSettings().GATEWAY_API_KEY).toBe("sk-mine");

  // 不是静默吞掉：app.log 里要留下可排查的一条
  const warnings = readAppLogsInMemory({ source: "settings" }).filter(
    (entry) => entry.event === "settings.decrypt.failed",
  );
  expect(warnings.length).toBe(1);
  expect(warnings[0]!.message).toContain("VLLM_API_KEY");
  expect(warnings[0]!.level).toBe("warn");
  // 密文原文不进日志（日志里出现的是键名与原因，不是值）
  expect(JSON.stringify(warnings[0])).not.toContain("sk-from-another-machine");

  // 解不开的键被清空后重新写入就拿回正常路径（用户重填一次密钥即可）
  updateSettings({ VLLM_API_KEY: "sk-reentered" });
  invalidateSettingsCache();
  expect(getSetting("VLLM_API_KEY")).toBe("sk-reentered");
});
