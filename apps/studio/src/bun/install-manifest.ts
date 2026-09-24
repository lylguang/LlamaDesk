/**
 * 安装完整性 manifest —— 让「装完了」变成一个可验证的事实。
 *
 * 引擎安装（尤其 vLLM / SGLang 这种 pip 装进 venv 的）被中途杀掉时，目录看起来是好的、
 * 二进制 `--help` 也答得出来，但依赖缺了一半，直到真正跑推理才炸。引擎目录的旧有探测
 * （目录在不在、版本探不探得到）回答不了「这次安装到底完成了没有」。
 *
 * 做法（思路参考 Unsloth Studio）：一个 manifest 文件，**安装开始前先删掉**，
 * **全部步骤做完的最后一步才原子写回**。于是「它存在」等价于「安装完成过」：
 *   - 被杀掉的安装 → 没有 manifest → `verifyInstall` 判 `missing`；
 *   - 写 manifest 是最后一道原子操作（tmp + rename）→ 不会有半个 JSON；
 *   - 读完字段再逐一核对（schema / version / platform / arch）→ 每种不一致一个原因。
 *
 * 文件落在**引擎目录本身**（`<engineDir>/.omni-install.json`）：卸载整个目录时自动消失，
 * 数据目录迁移时跟着走，不需要额外注册。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

import type { LocalEngineId } from "../shared/local-engines";

export const INSTALL_MANIFEST_SCHEMA = 1;
export const INSTALL_MANIFEST_FILE = ".omni-install.json";

export type InstallManifest = {
  schema: number;
  /** 哪个引擎（`LocalEngineId`）。 */
  engine: string;
  /** 完成时间（毫秒时间戳），由写入方填。 */
  completedAt: number;
  /** 装的是哪个版本（探不到给 null）。 */
  version: string | null;
  platform: string;
  arch: string;
  /** 这次安装一共几步（便于排查卡在哪一步）。 */
  steps: number;
};

/**
 * 验证结果的原因。方向是「没装完」：宁可让用户重装一次，也不能放过一个残缺的安装
 * （与别处的 fail-open 相反 —— 这里 `ok: false` 才是安全侧）。
 */
export type VerifyReason = "ok" | "missing" | "corrupt" | "schema" | "version-changed" | "platform-changed";

export function manifestPath(engineDir: string): string {
  return join(engineDir, INSTALL_MANIFEST_FILE);
}

/**
 * 安装开始前调用。返回 false 表示「没能删掉」—— 残留的 manifest 会让一次被杀掉的
 * 安装在下次被验证成「完成」，比没有 manifest 更糟，所以调用方必须中止安装。
 * 文件本来就不存在时返回 true（目标已达成）。
 */
export function removeManifest(engineDir: string): boolean {
  try {
    rmSync(manifestPath(engineDir), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 安装全部完成后的**最后一步**调用。tmp + rename 原子写：被 SIGKILL 时
 * 最多留下一个带 pid 的临时文件，不会留下半个 JSON。
 */
export function writeManifest(
  engineDir: string,
  m: Omit<InstallManifest, "schema" | "completedAt">,
): boolean {
  try {
    mkdirSync(engineDir, { recursive: true });
    const manifest: InstallManifest = { schema: INSTALL_MANIFEST_SCHEMA, completedAt: Date.now(), ...m };
    const tmp = join(engineDir, `${INSTALL_MANIFEST_FILE}.tmp-${process.pid}`);
    writeFileSync(tmp, JSON.stringify(manifest, null, 2), "utf8");
    renameSync(tmp, manifestPath(engineDir));
    return true;
  } catch {
    return false;
  }
}

/** 读回 manifest；文件不在或 JSON 损坏时返回 null（原因由 `verifyInstall` 区分）。 */
export function readManifest(engineDir: string): InstallManifest | null {
  let raw: string;
  try {
    raw = readFileSync(manifestPath(engineDir), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isManifest(parsed)) return null;
  return parsed;
}

/**
 * 「这次安装完成了吗」的唯一判据。所有文件操作都在 try/catch 里，异常转成
 * 上面的 reason，不往外抛（调用方在探测循环里跑，不能因为一个坏文件崩掉整张表）。
 */
export function verifyInstall(
  engineDir: string,
  expected: { engine: string; version?: string | null },
): { ok: boolean; reason: VerifyReason } {
  const fail = (reason: VerifyReason): { ok: boolean; reason: VerifyReason } => ({ ok: false, reason });
  let raw: string;
  try {
    raw = readFileSync(manifestPath(engineDir), "utf8");
  } catch {
    return fail("missing");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("corrupt");
  }
  if (!isManifest(parsed)) return fail("corrupt");
  if (parsed.schema !== INSTALL_MANIFEST_SCHEMA) return fail("schema");
  if (parsed.engine !== expected.engine) return fail("corrupt");
  if (expected.version != null && parsed.version !== expected.version) return fail("version-changed");
  if (parsed.platform !== process.platform || parsed.arch !== process.arch) return fail("platform-changed");
  return { ok: true, reason: "ok" };
}

/** 结构校验：manifest 的每个字段都是定死的形状，缺一个 / 类型不对都当损坏。 */
function isManifest(value: unknown): value is InstallManifest {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.schema === "number" &&
    typeof m.engine === "string" &&
    typeof m.completedAt === "number" &&
    (m.version === null || typeof m.version === "string") &&
    typeof m.platform === "string" &&
    typeof m.arch === "string" &&
    typeof m.steps === "number"
  );
}

/** 把 `LocalEngineId` 装进 manifest 用的便捷别名（类型上 engine 是 string）。 */
export type ManifestEngine = LocalEngineId;
