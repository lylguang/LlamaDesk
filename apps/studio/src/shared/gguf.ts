/**
 * GGUF 头部解析（主进程与界面共用，纯函数，不做 IO）。
 *
 * 启动 llama.cpp 前只读文件头（magic + metadata KV），拿到架构 / 层数 / KV 头数 /
 * 训练上下文等元数据，用来自动推算启动参数。字节流由调用方喂进来，读到多少算多少：
 * 不够时返回 truncated + needBytes，调用方可以再等再试。
 */

export type GgufValue = number | bigint | boolean | string | GgufValue[];

export type GgufParseResult =
  | {
      ok: true;
      version: number;
      tensorCount: bigint;
      kv: Record<string, GgufValue>;
      /** 每个 ARRAY 类型 KV 的元素个数（被跳过的超大数组也在这里，kv 里对应的是 []） */
      arrayLengths: Record<string, number>;
      headerBytes: number;
    }
  | {
      ok: false;
      error: "not-gguf" | "unsupported-version" | "truncated" | "malformed";
      needBytes?: number;
    };

// 防御性上限：损坏文件不能把内存撑爆
const MAX_STRING_LEN = 64 * 1024 * 1024; // 64 MiB
const MAX_ARRAY_LEN = 100_000_000;
const MAX_KV_COUNT = 100_000;
const MAX_TENSOR_COUNT = 10_000_000;

// 超大数组只前移偏移、不实际解析（tokenizer 词表可达数十万条字符串）
const SKIP_ARRAY_THRESHOLDS: Record<number, number> = { 8: 1024, 9: 100_000 };

const VALUE_SIZES: Record<number, number> = {
  0: 1,
  1: 1,
  2: 2,
  3: 2,
  4: 4,
  5: 4,
  6: 4,
  7: 1,
  10: 8,
  11: 8,
  12: 8,
};

type Reader = {
  bytes: Uint8Array;
  off: number;
  dv: DataView;
};

function fail(
  error: "not-gguf" | "unsupported-version" | "truncated" | "malformed",
  needBytes?: number,
): GgufParseResult {
  return needBytes === undefined ? { ok: false, error } : { ok: false, error, needBytes };
}

function utf8Decode(bytes: Uint8Array, start: number, end: number): string {
  // 与 main / webview 两端都有的 TextDecoder 解法一致
  return new TextDecoder("utf-8").decode(bytes.subarray(start, end));
}

function readU64(r: Reader, off: number): bigint {
  return (
    BigInt(r.dv.getUint32(off, true)) + BigInt(r.dv.getUint32(off + 4, true)) * BigInt(0x100000000)
  );
}

function readI64(r: Reader, off: number): bigint {
  const lo = BigInt(r.dv.getUint32(off, true));
  const hi = BigInt(r.dv.getUint32(off + 4, true));
  let v = (hi << 32n) | lo;
  if (hi >= (1n << 31n)) v -= 1n << 64n;
  return v;
}

// 读 GGUF 字符串，返回 [值, 结束后偏移]；数据不够返回 null（外层算 needBytes）
function readGgufString(r: Reader, off: number): [string, number] | null | "malformed" {
  if (off + 8 > r.bytes.length) return null;
  const len = Number(readU64(r, off));
  if (len > MAX_STRING_LEN) return "malformed";
  if (off + 8 + len > r.bytes.length) return null;
  const [val, end] = [utf8Decode(r.bytes, off + 8, off + 8 + len), off + 8 + len];
  return [val, end];
}

// 读一个值（不带类型前缀）。返回 [值, 结束后偏移]；null = 数据不够；"malformed"
type ReadOut = [GgufValue, number] | null | "malformed";

// 只用来从 parseArray / skipArrayContent 里中断出 "malformed"
class MalformedError extends Error {}

// 数组被跳过时把真实元素个数记进去（跳过时 kv 里是 []，长度只能从这里拿）
type ArraySkip = (
  r: Reader,
  off: number,
  elemType: number,
  count: number,
) => [GgufValue, number] | null;

function parseValue(r: Reader, off: number, type: number, arraySkip?: ArraySkip): ReadOut {
  const size = VALUE_SIZES[type];
  if (size !== undefined) {
    if (off + size > r.bytes.length) return null;
    let v: GgufValue;
    switch (type) {
      case 0:
        v = r.dv.getUint8(off);
        break;
      case 1:
        v = r.dv.getInt8(off);
        break;
      case 2:
        v = r.dv.getUint16(off, true);
        break;
      case 3:
        v = r.dv.getInt16(off, true);
        break;
      case 4:
        v = r.dv.getUint32(off, true);
        break;
      case 5:
        v = r.dv.getInt32(off, true);
        break;
      case 6:
        v = r.dv.getFloat32(off, true);
        break;
      case 7:
        v = r.dv.getUint8(off) !== 0;
        break;
      case 10:
        v = readU64(r, off);
        break;
      case 11:
        v = readI64(r, off);
        break;
      default:
        v = r.dv.getFloat64(off, true);
    }
    return [v, off + size];
  }
  if (type === 8) {
    const s = readGgufString(r, off);
    if (s === "malformed") return "malformed";
    if (s === null) return null;
    return [s[0], s[1]];
  }
  if (type === 9) return parseArray(r, off, arraySkip);
  return "malformed";
}

function parseArray(r: Reader, off: number, arraySkip?: ArraySkip): ReadOut {
  if (off + 12 > r.bytes.length) return null;
  const elemType = r.dv.getUint32(off, true);
  const count = Number(readU64(r, off + 4));
  if (count > MAX_ARRAY_LEN) return "malformed";
  const contentStart = off + 12;
  const skipThreshold = SKIP_ARRAY_THRESHOLDS[elemType];
  if (skipThreshold !== undefined && count > skipThreshold) {
    return arraySkip === undefined
      ? skipArrayContent(r, contentStart, elemType, count)
      : arraySkip(r, contentStart, elemType, count);
  }
  const arr: GgufValue[] = [];
  let cur = contentStart;
  for (let i = 0; i < count; i++) {
    const out = parseValue(r, cur, elemType, arraySkip);
    if (out === "malformed") return "malformed";
    if (out === null) return null;
    arr.push(out[0]);
    cur = out[1];
  }
  return [arr, cur];
}

// 只前移偏移不解析内容，返回 [[], 结束后偏移]；数据不够返回 null（外层用平均值估 needBytes）
function skipArrayContent(
  r: Reader,
  off: number,
  elemType: number,
  count: number,
): [GgufValue, number] | null {
  if (elemType === 8) {
    let cur = off;
    for (let i = 0; i < count; i++) {
      const s = readGgufString(r, cur);
      if (s === "malformed") throw new MalformedError();
      if (s === null) return null;
      cur = s[1];
    }
    return [[], cur];
  }
  const size = VALUE_SIZES[elemType];
  if (size !== undefined) {
    const end = off + size * count;
    return end > r.bytes.length ? null : [[], end];
  }
  if (elemType === 9) {
    if (off + 12 > r.bytes.length) return null;
    const inner = r.dv.getUint32(off, true);
    const innerCount = Number(readU64(r, off + 4));
    if (innerCount > MAX_ARRAY_LEN) throw new MalformedError();
    return skipArrayContent(r, off + 12, inner, innerCount);
  }
  throw new MalformedError();
}

function parseGgufCore(r: Reader): GgufParseResult {
  const { bytes } = r;
  if (bytes.length < 16) {
    return fail("truncated", 16);
  }
  if (
    bytes[0] !== 0x47 || bytes[1] !== 0x47 || bytes[2] !== 0x55 || bytes[3] !== 0x46
  ) {
    return fail("not-gguf");
  }
  const version = r.dv.getUint32(4, true);
  if (version !== 2 && version !== 3) return fail("unsupported-version");
  const tensorCount = readU64(r, 8);
  const kvCount = Number(readU64(r, 16));
  if (tensorCount > BigInt(MAX_TENSOR_COUNT)) return fail("malformed");
  if (kvCount > MAX_KV_COUNT) return fail("malformed");
  if (bytes.length < 24) return fail("truncated", 24);

  const kv: Record<string, GgufValue> = {};
  const arrayLengths: Record<string, number> = {};
  let off = 24;
  for (let i = 0; i < kvCount; i++) {
    // key
    if (off + 8 > bytes.length) return fail("truncated", bytes.length + 16);
    const keyLen = Number(readU64(r, off));
    if (keyLen > MAX_STRING_LEN) return fail("malformed");
    if (off + 8 + keyLen > bytes.length) {
      return fail("truncated", Math.max(off + 8 + keyLen + 4 + 16, bytes.length + 16));
    }
    const key = utf8Decode(bytes, off + 8, off + 8 + keyLen);
    // 跳过超大数组的替代实现：只前移偏移不解析，但把真实元素个数记进 arrayLengths
    const skipArrayWithRecord: ArraySkip = (r2, off2, elemType, count) => {
      const out = skipArrayContent(r2, off2, elemType, count);
      if (out !== null) arrayLengths[key] = count;
      return out;
    };
    off += 8 + keyLen;
    // value type
    if (off + 4 > bytes.length) return fail("truncated", off + 4 + 8);
    const valueType = r.dv.getUint32(off, true);
    off += 4;
    let out: ReadOut;
    try {
      out = parseValue(r, off, valueType, skipArrayWithRecord);
    } catch (e) {
      if (e instanceof MalformedError) return fail("malformed");
      throw e;
    }
    if (out === "malformed") return fail("malformed");
    if (out === null) {
      // 数据不够：off-4（值类型字段已消费但值未读到）+ 剩余 KV 的保守估计
      const remain = kvCount - i;
      const estimate = (off - 4) + 40 * remain;
      return fail("truncated", Math.max(estimate, bytes.length + 16));
    }
    kv[key] = out[0];
    off = out[1];
    if (valueType === 9 && Array.isArray(out[0])) {
      // 完整解析的数组用真值；跳过的数组在上面的 skip 回调里已记下
      if (!(key in arrayLengths)) arrayLengths[key] = (out[0] as GgufValue[]).length;
    }
  }
  return { ok: true, version, tensorCount, kv, arrayLengths, headerBytes: off };
}

export function parseGguf(input: ArrayBuffer | Uint8Array): GgufParseResult {
  const bytes =
    input instanceof Uint8Array ? input : new Uint8Array(input);
  const r: Reader = { bytes, off: 0, dv: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
  return parseGgufCore(r);
}

// ---------- 元数据归一化 ----------

export type GgufModelMeta = {
  architecture: string | null;
  name: string | null;
  fileType: number | null;
  quantLabel: string | null;
  blockCount: number | null;
  embeddingLength: number | null;
  headCount: number | null;
  headCountKv: number | null;
  keyLength: number | null;
  valueLength: number | null;
  headDim: number | null;
  contextLength: number | null;
  ropeFreqBase: number | null;
  ropeScalingType: string | null;
  ropeScalingFactor: number | null;
  expertCount: number | null;
  expertUsedCount: number | null;
  vocabSize: number | null;
  splitCount: number | null;
  headCountKvByLayer: number[] | null;
  kvLoraRank: number | null;
  keyLengthMla: number | null;
  slidingWindow: number | null;
  slidingWindowPattern: boolean[] | null;
  keyLengthSwa: number | null;
  valueLengthSwa: number | null;
  sharedKvLayers: number | null;
  fullAttentionInterval: number | null;
  ssmInnerSize: number | null;
  ssmStateSize: number | null;
  ssmConvKernel: number | null;
  ssmGroupCount: number | null;
  nextnPredictLayers: number | null;
  feedForwardLength: number | null;
  leadingDenseBlockCount: number | null;
};

// llama.cpp 的 llama_ftype
const QUANT_LABELS: Record<number, string> = {
  0: "F32",
  1: "F16",
  2: "Q4_0",
  3: "Q4_1",
  7: "Q8_0",
  8: "Q5_0",
  9: "Q5_1",
  10: "Q2_K",
  11: "Q3_K_S",
  12: "Q3_K_M",
  13: "Q3_K_L",
  14: "Q4_K_S",
  15: "Q4_K_M",
  16: "Q5_K_S",
  17: "Q5_K_M",
  18: "Q6_K",
  19: "IQ2_XXS",
  20: "IQ2_XS",
  21: "Q2_K_S",
  22: "IQ3_XS",
  23: "IQ3_XXS",
  24: "IQ1_S",
  25: "IQ4_NL",
  26: "IQ3_S",
  27: "IQ3_M",
  28: "IQ2_S",
  29: "IQ2_M",
  30: "IQ4_XS",
  31: "IQ1_M",
  32: "BF16",
  36: "TQ1_0",
  37: "TQ2_0",
};

function asString(v: GgufValue | undefined): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

// bigint / number 安全转有限正整数，否则 null
function asPositiveInt(v: GgufValue | undefined): number | null {
  if (typeof v === "bigint") {
    if (v <= 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(v);
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v <= 0 || !Number.isInteger(v)) return null;
    return v;
  }
  return null;
}

// 有限正实数（rope.freq_base 之类）
function asPositiveNumber(v: GgufValue | undefined): number | null {
  if (typeof v === "bigint") {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  return null;
}

function asArray(v: GgufValue | undefined): GgufValue[] | null {
  return Array.isArray(v) ? v : null;
}

// 数组元素全是有限正整数时返回 number[]（含 0 的合法，比如逐层 head_count_kv 允许 0 表示该层用全局注意力），
// 任一元素不合法则 null
function asNonNegIntArray(v: GgufValue | undefined): number[] | null {
  const arr = asArray(v);
  if (arr === null || arr.length === 0) return null;
  const out: number[] = [];
  for (const e of arr) {
    if (typeof e === "bigint") {
      if (e < 0n || e > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      out.push(Number(e));
    } else if (typeof e === "number" && Number.isFinite(e) && Number.isInteger(e) && e >= 0) {
      out.push(e);
    } else {
      return null;
    }
  }
  return out;
}

// sliding_window_pattern：数组（bool 或 0/1）原样转；标量 period 展开成长度 blockCount 的数组，
// 第 i 层（0 起）为 ((i + 1) % period) !== 0（每 period 层最后一层是全局注意力 = false）
function slidingWindowPattern(
  raw: GgufValue | undefined,
  blockCount: number | null,
): boolean[] | null {
  const arr = asArray(raw);
  if (arr !== null) {
    const out: boolean[] = [];
    for (const e of arr) {
      let b: boolean | null = null;
      if (typeof e === "boolean") b = e;
      else if (typeof e === "number" && (e === 0 || e === 1)) b = e === 1;
      else if (typeof e === "bigint" && (e === 0n || e === 1n)) b = e === 1n;
      if (b === null) return null;
      out.push(b);
    }
    return out;
  }
  const period = asPositiveInt(raw);
  if (period === null || blockCount === null) return null;
  return Array.from({ length: blockCount }, (_, i) => (i + 1) % period !== 0);
}

export function ggufModelMeta(
  kv: Record<string, GgufValue>,
  arrayLengths?: Record<string, number>,
): GgufModelMeta {
  const arch = asString(kv["general.architecture"]);
  let prefix: string | null;
  if (arch !== null) {
    prefix = arch;
  } else {
    // 兜底：找任何 .block_count 后缀的 key
    const suffixHit = Object.keys(kv).find((k) => k.endsWith(".block_count"));
    prefix = suffixHit ? suffixHit.slice(0, suffixHit.length - ".block_count".length) : null;
  }
  const g = (suffix: string): GgufValue | undefined =>
    prefix === null ? undefined : kv[`${prefix}.${suffix}`];

  const embeddingLength = asPositiveInt(g("embedding_length"));
  const headCount = asPositiveInt(g("attention.head_count"));
  const keyLength = asPositiveInt(g("attention.key_length"));
  const valueLength = asPositiveInt(g("attention.value_length"));

  const headCountKvByLayer = asNonNegIntArray(g("attention.head_count_kv"));
  let headCountKv: number | null =
    headCountKvByLayer !== null ? Math.max(...headCountKvByLayer) : asPositiveInt(g("attention.head_count_kv"));
  if (headCountKv === null) headCountKv = headCount; // MHA 回退

  let headDim: number | null = null;
  if (keyLength !== null) {
    headDim = keyLength;
  } else if (embeddingLength !== null && headCount !== null && embeddingLength % headCount === 0) {
    headDim = embeddingLength / headCount;
  }

  const vocabFromArch = asPositiveInt(g("vocab_size"));
  let vocabSize = vocabFromArch;
  if (vocabSize === null) {
    // 回退：词表数组长度（跳过的超大数组只有 arrayLengths 里有真长度，kv 里是 []）
    const tokensLen =
      arrayLengths?.["tokenizer.ggml.tokens"] ?? asArray(kv["tokenizer.ggml.tokens"])?.length ?? 0;
    vocabSize = tokensLen > 0 ? tokensLen : null;
  }

  const fileType = asPositiveInt(kv["general.file_type"]);
  const blockCount = asPositiveInt(g("block_count"));
  const swPeriod = g("attention.sliding_window_pattern");
  // sliding_window 只认 attention.sliding_window（窗口长度，token 数）；
  // sliding_window_pattern 的标量是周期（每几层一个全局注意力层），量纲不同，绝不能当窗口回退。
  const slidingWindow = asPositiveInt(g("attention.sliding_window"));

  return {
    architecture: arch,
    name: asString(kv["general.name"]),
    fileType,
    quantLabel: fileType === null ? null : (QUANT_LABELS[fileType] ?? null),
    blockCount,
    embeddingLength,
    headCount,
    headCountKv,
    keyLength,
    valueLength,
    headDim,
    contextLength: asPositiveInt(g("context_length")),
    ropeFreqBase: asPositiveNumber(g("rope.freq_base")),
    ropeScalingType: asString(g("rope.scaling.type")),
    ropeScalingFactor: asPositiveNumber(g("rope.scaling.factor")),
    expertCount: asPositiveInt(g("expert_count")),
    expertUsedCount: asPositiveInt(g("expert_used_count")),
    vocabSize,
    splitCount: asPositiveInt(kv["split.count"]),
    headCountKvByLayer,
    kvLoraRank: asPositiveInt(g("attention.kv_lora_rank")),
    keyLengthMla: asPositiveInt(g("attention.key_length_mla")),
    slidingWindow,
    slidingWindowPattern: slidingWindowPattern(swPeriod, blockCount),
    keyLengthSwa: asPositiveInt(g("attention.key_length_swa")),
    valueLengthSwa: asPositiveInt(g("attention.value_length_swa")),
    sharedKvLayers: asPositiveInt(g("attention.shared_kv_layers")),
    fullAttentionInterval: asPositiveInt(g("full_attention_interval")),
    ssmInnerSize: asPositiveInt(g("ssm.inner_size")),
    ssmStateSize: asPositiveInt(g("ssm.state_size")),
    ssmConvKernel: asPositiveInt(g("ssm.conv_kernel")),
    ssmGroupCount: asPositiveInt(g("ssm.group_count")),
    nextnPredictLayers: asPositiveInt(g("nextn_predict_layers")),
    feedForwardLength: asPositiveInt(g("feed_forward_length")),
    leadingDenseBlockCount: asPositiveInt(g("leading_dense_block_count")),
  };
}
