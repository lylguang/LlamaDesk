import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { db } from "./db";
import { knowledgeBases } from "./db/schema";
import { isEncryptedSecret } from "./secrets";
import { createKb, getKb, listKnowledgeBases, updateKb } from "./knowledge";

/**
 * 知识库的嵌入 / 重排密钥同样落盘加密（FUT-02）。
 *
 * 这两列以前是明文：它们和厂商行的 Key 是同一类东西（拿着就能调用上游、花用户的钱），
 * 却因为「写在另一个表里」而漏在名单外。这里钉住三件事：落盘是密文、读出来是明文、
 * 老库里的明文读得到（透传）且在第一次读取时被翻成密文。
 */

/** 直接读库里的原始值，绕过解密。 */
function rawKeys(id: number): { embeddingApiKey: string; rerankApiKey: string } {
  const row = db.select().from(knowledgeBases).where(eq(knowledgeBases.id, id)).get()!;
  return { embeddingApiKey: row.embeddingApiKey, rerankApiKey: row.rerankApiKey };
}

test("写入即加密：盘上是密文，读出来是明文", () => {
  const kb = createKb({ name: "加密往返" });
  updateKb(kb.id, { embeddingApiKey: "sk-embed-secret-value", rerankApiKey: "sk-rerank-secret-value" });

  const raw = rawKeys(kb.id);
  expect(isEncryptedSecret(raw.embeddingApiKey)).toBe(true);
  expect(isEncryptedSecret(raw.rerankApiKey)).toBe(true);
  expect(raw.embeddingApiKey).not.toContain("sk-embed-secret-value");

  expect(getKb(kb.id)?.embeddingApiKey).toBe("sk-embed-secret-value");
  expect(getKb(kb.id)?.rerankApiKey).toBe("sk-rerank-secret-value");
  const listed = listKnowledgeBases().find((item) => item.id === kb.id);
  expect(listed?.embeddingApiKey).toBe("sk-embed-secret-value");
  expect(listed?.rerankApiKey).toBe("sk-rerank-secret-value");
});

test("空值不制造密文（清空 = 真的清空）", () => {
  const kb = createKb({ name: "清空密钥" });
  updateKb(kb.id, { embeddingApiKey: "sk-temp-value" });
  updateKb(kb.id, { embeddingApiKey: "" });
  expect(rawKeys(kb.id).embeddingApiKey).toBe("");
  expect(getKb(kb.id)?.embeddingApiKey).toBe("");
});

test("老库里的明文：读得到（透传），并在第一次读取时被翻成密文", () => {
  const kb = createKb({ name: "历史明文" });
  // 模拟升级前的老数据：直接写明文进库。
  db.update(knowledgeBases)
    .set({ embeddingApiKey: "plain-legacy-embed" })
    .where(eq(knowledgeBases.id, kb.id))
    .run();
  expect(isEncryptedSecret(rawKeys(kb.id).embeddingApiKey)).toBe(false);

  expect(getKb(kb.id)?.embeddingApiKey).toBe("plain-legacy-embed");

  const raw = rawKeys(kb.id);
  expect(isEncryptedSecret(raw.embeddingApiKey)).toBe(true);
  expect(raw.embeddingApiKey).not.toContain("plain-legacy-embed");
  expect(getKb(kb.id)?.embeddingApiKey).toBe("plain-legacy-embed");
});
