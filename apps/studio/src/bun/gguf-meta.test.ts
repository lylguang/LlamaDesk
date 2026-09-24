import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readGgufMeta, clearGgufMetaCache } from "./gguf-meta";

// ---------- 测试辅助：合成 GGUF 字节流（复制自 shared/gguf.test.ts，不从 .test.ts import） ----------

const u32 = (v: number) => new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
const u64 = (v: number | bigint) => {
  const n = typeof v === "bigint" ? v : BigInt(v);
  const lo = Number(n & 0xffffffffn);
  const hi = Number((n >> 32n) & 0xffffffffn);
  return new Uint8Array([...u32(lo), ...u32(hi)]);
};
const f32 = (v: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, v, true);
  return b;
};
const str = (s: string) => {
  const b = new TextEncoder().encode(s);
  return new Uint8Array([...u64(b.length), ...b]);
};

type KV = { key: string; type: number; value: Uint8Array };

function buildGguf(
  kvEntries: KV[],
  opts?: { version?: number; tensorCount?: number },
): Uint8Array {
  const magic = new TextEncoder().encode("GGUF");
  const body = kvEntries.flatMap((kv) => [str(kv.key), u32(kv.type), kv.value]);
  return new Uint8Array([
    ...magic,
    ...u32(opts?.version ?? 3),
    ...u64(opts?.tensorCount ?? 0),
    ...u64(kvEntries.length),
    ...body.flatMap((b) => Array.from(b)),
  ]);
}

function kvStr(key: string, value: string): KV {
  return { key, type: 8, value: str(value) };
}

function kvU32(key: string, value: number): KV {
  return { key, type: 4, value: u32(value) };
}

function kvF32(key: string, value: number): KV {
  return { key, type: 6, value: f32(value) };
}

async function writeBytes(p: string, bytes: Uint8Array): Promise<void> {
  await writeFile(p, bytes);
}

// ---------- ----------

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "gguf-meta-test-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readGgufMeta", () => {
  test("正常读取合成的小 GGUF：字段齐全", async () => {
    const bytes = buildGguf(
      [
        kvStr("general.architecture", "llama"),
        kvStr("general.name", "tiny"),
        kvU32("llama.block_count", 32),
        kvU32("llama.attention.head_count", 32),
        kvU32("llama.attention.head_count_kv", 8),
        kvU32("llama.embedding_length", 4096),
        kvU32("llama.context_length", 8192),
        kvU32("general.file_type", 15),
        kvF32("llama.rope.freq_base", 10000),
      ],
      { tensorCount: 123 },
    );
    const p = join(dir, "tiny.gguf");
    await writeBytes(p, bytes);
    const r = await readGgufMeta(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.version).toBe(3);
    expect(r.data.tensorCount).toBe(123);
    expect(r.data.meta.architecture).toBe("llama");
    expect(r.data.meta.blockCount).toBe(32);
    expect(r.data.meta.headCount).toBe(32);
    expect(r.data.meta.headCountKv).toBe(8);
    expect(r.data.meta.embeddingLength).toBe(4096);
    expect(r.data.meta.contextLength).toBe(8192);
    expect(r.data.meta.fileType).toBe(15);
    expect(r.data.meta.quantLabel).toBe("Q4_K_M");
    expect(r.data.meta.ropeFreqBase).toBe(10000);
    expect(r.data.shardCount).toBe(1);
    expect(r.data.totalFileBytes).toBe(bytes.length);
    expect(r.data.filePath).toBe(p);
  });

  test("增量扩读：元数据区超过 1 MiB（2 MiB 字符串 KV）仍能正确读出", async () => {
    // 2 MiB 字符串 KV，总长约 2 MiB+66，远超 1 MiB 初始窗口，需多轮扩读
    const big = "x".repeat(2 * 1024 * 1024);
    const bytes = buildGguf([
      kvStr("big.blob", big),
      kvStr("general.architecture", "llama"),
      kvU32("llama.block_count", 12),
    ]);
    expect(bytes.length).toBeGreaterThan(1024 * 1024);
    const p = join(dir, "big.gguf");
    await writeBytes(p, bytes);
    const r = await readGgufMeta(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.meta.architecture).toBe("llama");
    expect(r.data.meta.blockCount).toBe(12);
    expect(r.data.meta.slidingWindow).toBeNull();
    expect(r.data.headerBytes).toBe(bytes.length);
    expect(r.data.totalFileBytes).toBe(bytes.length);
  });

  test("分片：传第 2 片 → 解析第 1 片，shardCount/totalFileBytes 覆盖同组", async () => {
    const shardDir = join(dir, "shards");
    await mkdir(shardDir, { recursive: true });
    const full = buildGguf([
      kvStr("general.architecture", "llama"),
      kvU32("llama.block_count", 8),
      kvU32("general.file_type", 3),
    ]);
    const p1 = join(shardDir, "m-00001-of-00002.gguf");
    const p2 = join(shardDir, "m-00002-of-00002.gguf");
    await writeBytes(p1, full);
    const junk = new Uint8Array(64).map((_, i) => (i * 37) % 256);
    await writeBytes(p2, junk);
    const r = await readGgufMeta(p2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.filePath).toBe(p1);
    expect(r.data.shardCount).toBe(2);
    expect(r.data.totalFileBytes).toBe(full.length + junk.length);
    expect(r.data.meta.architecture).toBe("llama");
  });

  test("缓存：两次读同一文件返回同一对象引用；clearGgufMetaCache 后重新读", async () => {
    const bytes = buildGguf([kvStr("general.architecture", "llama")]);
    const p = join(dir, "cached.gguf");
    await writeBytes(p, bytes);
    const r1 = await readGgufMeta(p);
    const r2 = await readGgufMeta(p);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r2.data).toBe(r1.data); // 同一引用 = 命中缓存
    clearGgufMetaCache();
    const r3 = await readGgufMeta(p);
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;
    expect(r3.data.meta.architecture).toBe("llama");
    expect(r3.data).not.toBe(r1.data);
  });

  test("不存在的路径 → not-found", async () => {
    const r = await readGgufMeta(join(dir, "nope.gguf"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("not-found");
  });

  test("非 GGUF 文件 → not-gguf（垃圾字节 ≥ 16，magic 校验落在窗口内）", async () => {
    const junk = new Uint8Array(32).fill(7);
    const p = join(dir, "notgguf.gguf");
    await writeBytes(p, junk);
    const r = await readGgufMeta(p);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("not-gguf");
  });
});
