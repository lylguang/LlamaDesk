import { describe, expect, test } from "bun:test";
import { ggufModelMeta, parseGguf, type GgufValue } from "./gguf";

// ---------- 测试辅助：合成 GGUF 字节流 ----------

const u32 = (v: number) => new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
const u64 = (v: number | bigint) => {
  const n = typeof v === "bigint" ? v : BigInt(v);
  const lo = Number(n & 0xffffffffn);
  const hi = Number((n >> 32n) & 0xffffffffn);
  return new Uint8Array([...u32(lo), ...u32(hi)]);
};
const u8 = (v: number) => new Uint8Array([v & 0xff]);
const i8 = (v: number) => new Uint8Array([v & 0xff]);
const u16 = (v: number) => new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
const i16 = (v: number) => u16(v);
const i32 = (v: number) => u32(v);
const i64 = (v: number | bigint) => u64(typeof v === "bigint" ? v : BigInt(v));
const f32 = (v: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, v, true);
  return b;
};
const f64 = (v: number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v, true);
  return b;
};
const str = (s: string) => {
  const b = new TextEncoder().encode(s);
  return new Uint8Array([...u64(b.length), ...b]);
};
const arr = (elemType: number, elems: Uint8Array[]) =>
  new Uint8Array([...u32(elemType), ...u64(elems.length), ...elems.flatMap((e) => [...e])]);
const bool = (v: boolean) => u8(v ? 1 : 0);

type KV = { key: string; type: number; value: Uint8Array };

function buildGguf(kvEntries: KV[], opts?: { magic?: string; version?: number; tensorCount?: number }): Uint8Array {
  const magic = new TextEncoder().encode(opts?.magic ?? "GGUF");
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

function kvU64(key: string, value: number | bigint): KV {
  return { key, type: 10, value: u64(value) };
}

function parseOrThrow(bytes: Uint8Array): Extract<ReturnType<typeof parseGguf>, { ok: true }> {
  const r = parseGguf(bytes);
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r;
}

describe("parseGguf", () => {
  test("正常解析并提取模型元数据", () => {
    const bytes = buildGguf([
      kvStr("general.architecture", "llama"),
      kvU32("llama.block_count", 32),
      kvU32("llama.attention.head_count", 32),
      kvU32("llama.attention.head_count_kv", 8),
      kvU32("llama.embedding_length", 4096),
      kvU32("llama.context_length", 8192),
      kvU32("general.file_type", 15),
    ]);
    const r = parseOrThrow(bytes);
    expect(r.version).toBe(3);
    expect(r.tensorCount).toBe(0n);
    expect(r.headerBytes).toBe(bytes.length);
    const meta = ggufModelMeta(r.kv);
    expect(meta.architecture).toBe("llama");
    expect(meta.blockCount).toBe(32);
    expect(meta.headCount).toBe(32);
    expect(meta.headCountKv).toBe(8);
    expect(meta.headDim).toBe(128);
    expect(meta.embeddingLength).toBe(4096);
    expect(meta.contextLength).toBe(8192);
    expect(meta.fileType).toBe(15);
    expect(meta.quantLabel).toBe("Q4_K_M");
  });

  test("magic 不对 → not-gguf", () => {
    const r = parseGguf(buildGguf([], { magic: "GGU" }));
    expect(r).toEqual({ ok: false, error: "not-gguf" });
  });

  test("version=1 → unsupported-version", () => {
    const r = parseGguf(buildGguf([], { version: 1 }));
    expect(r).toEqual({ ok: false, error: "unsupported-version" });
  });

  test("字节截断 → truncated 且 needBytes 大于已读长度", () => {
    const full = buildGguf([
      kvStr("general.architecture", "llama"),
      kvU32("llama.block_count", 32),
      kvU32("llama.attention.head_count", 32),
    ]);
    const half = full.subarray(0, Math.floor(full.length / 2));
    const r = parseGguf(half);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("truncated");
    expect(r.needBytes).toBeGreaterThan(half.length);
  });

  test("未知 value_type → malformed", () => {
    const r = parseGguf(buildGguf([{ key: "foo", type: 99, value: u8(1) }]));
    expect(r).toEqual({ ok: false, error: "malformed" });
  });

  test("各种标量类型正确读出", () => {
    const bytes = buildGguf([
      { key: "a.u8", type: 0, value: u8(7) },
      { key: "a.i8", type: 1, value: i8(-7) },
      { key: "a.u16", type: 2, value: u16(60000) },
      { key: "a.i16", type: 3, value: i16(-30000) },
      { key: "a.u32", type: 4, value: u32(4000000000) },
      { key: "a.i32", type: 5, value: i32(-2000000000) },
      { key: "a.f32", type: 6, value: f32(1.5) },
      { key: "a.bool", type: 7, value: bool(true) },
      { key: "a.u64", type: 10, value: u64(18446744073709551615n) },
      { key: "a.i64", type: 11, value: i64(-1n) },
      { key: "a.i64min", type: 11, value: i64(-(2n ** 63n)) },
      { key: "a.i64max", type: 11, value: i64(2n ** 63n - 1n) },
      { key: "a.f64", type: 12, value: f64(-2.25) },
      { key: "a.str", type: 8, value: str("你好") },
    ]);
    const r = parseOrThrow(bytes);
    const kv = r.kv;
    expect(kv["a.u8"]).toBe(7);
    expect(kv["a.i8"]).toBe(-7);
    expect(kv["a.u16"]).toBe(60000);
    expect(kv["a.i16"]).toBe(-30000);
    expect(kv["a.u32"]).toBe(4000000000);
    expect(kv["a.i32"]).toBe(-2000000000);
    expect(kv["a.f32"]).toBeCloseTo(1.5);
    expect(kv["a.bool"]).toBe(true);
    expect(kv["a.u64"]).toBe(18446744073709551615n);
    expect(kv["a.i64"]).toBe(-1n);
    expect(kv["a.i64min"]).toBe(-(2n ** 63n));
    expect(kv["a.i64max"]).toBe(2n ** 63n - 1n);
    expect(kv["a.f64"]).toBe(-2.25);
    expect(kv["a.str"]).toBe("你好");
  });

  test("u32 数组正确解析；2000 元素字符串数组被跳过且偏移量仍对齐", () => {
    const u32elems = [u32(1), u32(2), u32(3)];
    const strElems = Array.from({ length: 2000 }, (_, i) => str(`tok${i}`));
    const bytes = buildGguf([
      { key: "u32arr", type: 9, value: arr(4, u32elems) },
      { key: "tokenizer.ggml.tokens", type: 9, value: arr(8, strElems) },
      kvU32("llama.block_count", 4),
    ]);
    const r = parseOrThrow(bytes);
    expect(r.kv["u32arr"]).toEqual([1, 2, 3]);
    expect(r.kv["tokenizer.ggml.tokens"]).toEqual([]);
    // 关键：跳过 2000 个字符串之后，第三条 KV 仍被正确读出
    expect(r.kv["llama.block_count"]).toBe(4);
    expect(r.headerBytes).toBe(bytes.length);
  });

  test("超大字符串数组（>1024）被跳过，后续 KV 正确", () => {
    const strElems = Array.from({ length: 2000 }, (_, i) => str(`tok${i}`));
    const bytes = buildGguf([
      { key: "big.tokens", type: 9, value: arr(8, strElems) },
      kvU32("x.after", 99),
    ]);
    const r = parseOrThrow(bytes);
    expect(r.kv["big.tokens"]).toEqual([]);
    expect(r.kv["x.after"]).toBe(99);
  });

  test("嵌套数组（数组的数组）解析", () => {
    const inner1 = arr(4, [u32(1), u32(2)]);
    const inner2 = arr(4, [u32(3)]);
    const bytes = buildGguf([{ key: "nested", type: 9, value: arr(9, [inner1, inner2]) }]);
    const r = parseOrThrow(bytes);
    expect(r.kv["nested"]).toEqual([[1, 2], [3]]);
  });

  test("head_count_kv 缺失时回落到 head_count", () => {
    const kv: Record<string, GgufValue> = {
      "general.architecture": "llama",
      "llama.attention.head_count": 16,
      "llama.embedding_length": 512,
    };
    const meta = ggufModelMeta(kv);
    expect(meta.headCountKv).toBe(16);
    expect(meta.headDim).toBe(32); // 512 / 16
  });

  test("general.architecture 缺失时靠 .block_count 后缀兜底", () => {
    const kv: Record<string, GgufValue> = {
      "mamba.block_count": 48,
      "mamba.attention.head_count": 24,
      "mamba.embedding_length": 768,
    };
    const meta = ggufModelMeta(kv);
    // architecture 本身是 general.architecture，缺失时 null；但其它字段靠后缀兜底仍能读到
    expect(meta.architecture).toBeNull();
    expect(meta.blockCount).toBe(48);
    expect(meta.headCount).toBe(24);
    expect(meta.embeddingLength).toBe(768);
  });

  test("keyLength 存在时 headDim 用 keyLength 而不是 embedding/head_count", () => {
    const kv: Record<string, GgufValue> = {
      "general.architecture": "qwen2",
      "qwen2.attention.head_count": 16,
      "qwen2.attention.key_length": 128,
      "qwen2.embedding_length": 2048,
    };
    const meta = ggufModelMeta(kv);
    expect(meta.headDim).toBe(128);
  });

  test("量化档位映射：已知档位给标签，未收录档位 null", () => {
    const known = ggufModelMeta({ "general.file_type": 18 });
    expect(known.fileType).toBe(18);
    expect(known.quantLabel).toBe("Q6_K");
    const unknown = ggufModelMeta({ "general.file_type": 99 });
    expect(unknown.fileType).toBe(99);
    expect(unknown.quantLabel).toBeNull();
  });

  test("embedding 不能被 head_count 整除时 headDim 为 null", () => {
    const kv: Record<string, GgufValue> = {
      "general.architecture": "llama",
      "llama.attention.head_count": 3,
      "llama.embedding_length": 100,
    };
    expect(ggufModelMeta(kv).headDim).toBeNull();
  });

  test("head_count_kv 是 u32 数组：逐层数组存 byLayer，标量字段取最大值", () => {
    const elems = [u32(8), u32(8), u32(0), u32(8)];
    const bytes = buildGguf([
      kvStr("general.architecture", "llama"),
      { key: "llama.attention.head_count_kv", type: 9, value: arr(4, elems) },
    ]);
    const r = parseOrThrow(bytes);
    const meta = ggufModelMeta(r.kv);
    expect(meta.headCountKvByLayer).toEqual([8, 8, 0, 8]);
    expect(meta.headCountKv).toBe(8);
  });

  test("sliding_window_pattern 是标量 period：按 block_count 展开（每 period 层最后一层全局）", () => {
    const bytes = buildGguf([
      kvStr("general.architecture", "qwen3"),
      kvU32("qwen3.block_count", 12),
      kvU32("qwen3.attention.sliding_window_pattern", 6),
    ]);
    const r = parseOrThrow(bytes);
    const meta = ggufModelMeta(r.kv);
    expect(meta.slidingWindowPattern).toHaveLength(12);
    if (meta.slidingWindowPattern === null) throw new Error("unreachable");
    expect(meta.slidingWindowPattern[5]).toBe(false);
    expect(meta.slidingWindowPattern[11]).toBe(false);
    for (let i = 0; i < 12; i++) {
      expect(meta.slidingWindowPattern[i]).toBe(i % 6 !== 5);
    }
  });

  test("只有 sliding_window_pattern（标量周期）而没有 attention.sliding_window 时，slidingWindow 是 null，绝不把周期当窗口", () => {
    const bytes = buildGguf([
      kvStr("general.architecture", "spark2_5"),
      kvU32("spark2_5.block_count", 36),
      kvU32("spark2_5.attention.sliding_window_pattern", 6),
    ]);
    const r = parseOrThrow(bytes);
    const meta = ggufModelMeta(r.kv);
    expect(meta.slidingWindow).toBeNull();
    expect(meta.slidingWindowPattern).toHaveLength(36);
    if (meta.slidingWindowPattern === null) throw new Error("unreachable");
    // 周期 6：每第 6 层（索引 5、11、17、23、29、35）是全局注意力
    expect(meta.slidingWindowPattern[5]).toBe(false);
    expect(meta.slidingWindowPattern[11]).toBe(false);
    expect(meta.slidingWindowPattern[35]).toBe(false);
    expect(meta.slidingWindowPattern[4]).toBe(true);
  });

  test("sliding_window_pattern 是 bool 数组：原样转换", () => {
    const bytes = buildGguf([
      kvStr("general.architecture", "qwen3"),
      { key: "qwen3.attention.sliding_window_pattern", type: 9, value: arr(7, [bool(true), bool(true), bool(false)]) },
    ]);
    const r = parseOrThrow(bytes);
    expect(ggufModelMeta(r.kv).slidingWindowPattern).toEqual([true, true, false]);
  });

  test("MLA：kv_lora_rank 与 key_length_mla 能读出", () => {
    const bytes = buildGguf([
      kvStr("general.architecture", "deepseek2"),
      kvU32("deepseek2.attention.kv_lora_rank", 512),
      kvU32("deepseek2.attention.key_length_mla", 64),
    ]);
    const r = parseOrThrow(bytes);
    const meta = ggufModelMeta(r.kv);
    expect(meta.kvLoraRank).toBe(512);
    expect(meta.keyLengthMla).toBe(64);
  });

  test("SSM/混合架构：full_attention_interval 与 ssm.* 能读出", () => {
    const bytes = buildGguf([
      kvStr("general.architecture", "qwen3next"),
      kvU32("qwen3next.full_attention_interval", 4),
      kvU32("qwen3next.ssm.inner_size", 6144),
      kvU32("qwen3next.ssm.state_size", 128),
      kvU32("qwen3next.ssm.conv_kernel", 4),
      kvU32("qwen3next.ssm.group_count", 16),
    ]);
    const r = parseOrThrow(bytes);
    const meta = ggufModelMeta(r.kv);
    expect(meta.fullAttentionInterval).toBe(4);
    expect(meta.ssmInnerSize).toBe(6144);
    expect(meta.ssmStateSize).toBe(128);
    expect(meta.ssmConvKernel).toBe(4);
    expect(meta.ssmGroupCount).toBe(16);
  });

  test("arrayLengths：被跳过的超大字符串数组与正常 u32 数组都记录长度", () => {
    const strElems = Array.from({ length: 2000 }, (_, i) => str(`tok${i}`));
    const u32elems = [u32(7), u32(8), u32(9)];
    const bytes = buildGguf([
      { key: "tokenizer.ggml.tokens", type: 9, value: arr(8, strElems) },
      { key: "small.u32arr", type: 9, value: arr(4, u32elems) },
    ]);
    const r = parseOrThrow(bytes);
    expect(r.arrayLengths["tokenizer.ggml.tokens"]).toBe(2000);
    expect(r.arrayLengths["small.u32arr"]).toBe(3);
    expect(r.kv["tokenizer.ggml.tokens"]).toEqual([]);
    expect(r.kv["small.u32arr"]).toEqual([7, 8, 9]);
  });

  test("vocabSize 回退：无 {arch}.vocab_size 时用 tokenizer.ggml.tokens 数组长度（含被跳过的）", () => {
    // 1200 个 token 超过字符串数组的跳过阈值（1024）：kv 里是 []，真长度只存在于 arrayLengths
    const strElems = Array.from({ length: 1200 }, (_, i) => str(`t${i}`));
    const bytes = buildGguf([
      kvStr("general.architecture", "llama"),
      { key: "tokenizer.ggml.tokens", type: 9, value: arr(8, strElems) },
    ]);
    const r = parseOrThrow(bytes);
    expect(ggufModelMeta(r.kv, r.arrayLengths).vocabSize).toBe(1200);
  });

  test("vocabSize 回退：不传 arrayLengths 时小词表走 kv 里的实际数组", () => {
    // 500 个 token 低于跳过阈值（1024），会被完整解析，kv 里有真数组
    const strElems = Array.from({ length: 500 }, (_, i) => str(`t${i}`));
    const bytes = buildGguf([
      kvStr("general.architecture", "llama"),
      { key: "tokenizer.ggml.tokens", type: 9, value: arr(8, strElems) },
    ]);
    const r = parseOrThrow(bytes);
    expect(ggufModelMeta(r.kv).vocabSize).toBe(500);
  });
});
