import { describe, expect, test } from "bun:test";

import type { GgufModelMeta } from "./gguf";
import {
  canEstimateKv,
  computeBufferCtxBytes,
  CUDA_CONTEXT_RESERVE_BYTES,
  estimateComputeBufferBytes,
  estimateKvCacheBytes,
  fitContextToBudget,
  heavierCacheType,
  KV_CELL_ALIGN,
  kvBytesPerElem,
  kvCellLayout,
  MIN_FIT_CTX,
  modelFootprintBytes,
  padKvCells,
  planLlamaLaunch,
  CTX_COMPUTE_NO_FA_MULT,
  CTX_COMPUTE_FA_MASK_MULT,
  resolveBudgetBytes,
  SYSTEM_MEMORY_BUDGET_RATIO,
  UNIFIED_MEMORY_BUDGET_RATIO,
  PIPELINE_PER_DEVICE_OVERHEAD_BYTES,
  type FitContextInput,
  type KvEstimateOpts,
  usableDeviceBytes,
  VRAM_FIT_FRACTION,
} from "./launch-planner";

// ---------- 测试用 meta 构造 ----------

function baseMeta(over: Partial<GgufModelMeta>): GgufModelMeta {
  const meta: GgufModelMeta = {
    architecture: null,
    name: null,
    fileType: null,
    quantLabel: null,
    blockCount: null,
    embeddingLength: null,
    headCount: null,
    headCountKv: null,
    keyLength: null,
    valueLength: null,
    headDim: null,
    contextLength: null,
    ropeFreqBase: null,
    ropeScalingType: null,
    ropeScalingFactor: null,
    expertCount: null,
    expertUsedCount: null,
    vocabSize: null,
    splitCount: null,
    headCountKvByLayer: null,
    kvLoraRank: null,
    keyLengthMla: null,
    slidingWindow: null,
    slidingWindowPattern: null,
    keyLengthSwa: null,
    valueLengthSwa: null,
    sharedKvLayers: null,
    fullAttentionInterval: null,
    ssmInnerSize: null,
    ssmStateSize: null,
    ssmConvKernel: null,
    ssmGroupCount: null,
    nextnPredictLayers: null,
    feedForwardLength: null,
    leadingDenseBlockCount: null,
  };
  return { ...meta, ...over };
}

const KV_OPTS: KvEstimateOpts = {
  ctxTokens: 32768,
  parallel: 1,
  kvUnified: false,
  cacheTypeK: "q8_0",
  cacheTypeV: "q8_0",
  flashAttn: true,
  ubatch: 512,
};

// ---------- 1. kvBytesPerElem ----------

describe("kvBytesPerElem", () => {
  const cases: Array<[string | null | undefined, number]> = [
    ["f32", 4],
    ["f16", 2],
    ["bf16", 2],
    ["q8_0", 34 / 32],
    ["q5_1", 0.75],
    ["q5_0", 0.6875],
    ["q4_1", 0.625],
    ["q4_0", 0.5625],
    ["iq4_nl", 0.5625],
  ];
  test.each(cases)("maps %s to the documented byte/elem", (name, want) => {
    expect(kvBytesPerElem(name)).toBe(want);
  });

  test("unknown / null / empty fall back to f16 (2.0)", () => {
    expect(kvBytesPerElem("q2_k")).toBe(2.0);
    expect(kvBytesPerElem("tq3_0")).toBe(2.0);
    expect(kvBytesPerElem("")).toBe(2.0);
    expect(kvBytesPerElem("   ")).toBe(2.0);
    expect(kvBytesPerElem(null)).toBe(2.0);
    expect(kvBytesPerElem(undefined)).toBe(2.0);
  });

  test("case-insensitive and trims whitespace", () => {
    expect(kvBytesPerElem("Q8_0")).toBe(kvBytesPerElem("q8_0"));
    expect(kvBytesPerElem("  BF16  ")).toBe(kvBytesPerElem("bf16"));
    expect(kvBytesPerElem("Q4_0")).toBe(0.5625);
  });
});

// ---------- 2. padKvCells ----------

describe("padKvCells", () => {
  test("0 -> 0", () => expect(padKvCells(0)).toBe(0));
  test("negative -> 0", () => expect(padKvCells(-256)).toBe(0));
  test("1 -> 256", () => expect(padKvCells(1)).toBe(256));
  test("256 -> 256", () => expect(padKvCells(256)).toBe(256));
  test("257 -> 512", () => expect(padKvCells(257)).toBe(512));
  test("rounds up to the next 256 multiple", () => expect(padKvCells(300)).toBe(512));
  test("exact multiples stay", () => expect(padKvCells(32768)).toBe(32768));
});

// ---------- 3. kvCellLayout ----------

describe("kvCellLayout", () => {
  test("(32768, 1, false) -> 1 stream, no padding", () => {
    const l = kvCellLayout(32768, 1, false);
    expect(l).toEqual({ slots: 1, streams: 1, cellsPerStream: 32768, totalCells: 32768 });
  });

  test("(65536, 3, false) -> 3 streams, per-stream padded to 22016", () => {
    const l = kvCellLayout(65536, 3, false);
    expect(l).toEqual({ slots: 3, streams: 3, cellsPerStream: 22016, totalCells: 66048 });
  });

  test("(65536, 3, true) -> single stream over the full padded ctx", () => {
    const l = kvCellLayout(65536, 3, true);
    expect(l).toEqual({ slots: 3, streams: 1, cellsPerStream: 65536, totalCells: 65536 });
  });

  test("parallel < 1 is clamped to one slot", () => {
    expect(kvCellLayout(1000, 0, false).slots).toBe(1);
    expect(kvCellLayout(1000, 0.4, false).slots).toBe(1);
  });
});

// ---------- 4. 锚点 A：hybrid-ssm（Qwen3.8-27B） ----------

describe("KV estimate: anchor A (hybrid-ssm, Qwen3.8-27B)", () => {
  const meta = baseMeta({
    blockCount: 65,
    embeddingLength: 5120,
    headCount: 24,
    headCountKv: 4,
    keyLength: 256,
    valueLength: 256,
    headDim: 256,
    fullAttentionInterval: 4,
    ssmInnerSize: 6144,
    contextLength: 262144,
  });

  test("branch / attentionLayers / bytes match the independent reference", () => {
    const est = estimateKvCacheBytes(meta, KV_OPTS);
    expect(est).not.toBeNull();
    if (est === null) return;
    expect(est.branch).toBe("hybrid-ssm");
    expect(est.attentionLayers).toBe(17); // ceil(65/4)
    // 17 * 32768 * (4*256*1.0625 + 4*256*1.0625) = 17 * 32768 * 7680
    expect(est.bytes).toBe(1212153856);
    expect(est.layout.totalCells).toBe(32768);
  });
});

// ---------- 5. 锚点 B：swa（Spark-X2.5-4B） ----------

describe("KV estimate: anchor B (swa, Spark-X2.5-4B)", () => {
  // 36 层，pattern 长度 36：索引 3,7,11,…,35 为 false（全局层），其余 true（滑窗层）
  const pattern: boolean[] = Array.from({ length: 36 }, (_, i) => (i + 1) % 4 !== 0);
  expect(pattern.filter((x) => !x).length).toBe(9); // 9 全局 + 27 滑窗

  const meta = baseMeta({
    blockCount: 36,
    embeddingLength: 2560,
    headCount: 16,
    headCountKv: 4,
    keyLength: 256,
    valueLength: 256,
    headDim: 256,
    slidingWindow: 512,
    slidingWindowPattern: pattern,
    vocabSize: 131072,
  });

  const opts: KvEstimateOpts = {
    ctxTokens: 65536,
    parallel: 3,
    kvUnified: false,
    cacheTypeK: "f16",
    cacheTypeV: "f16",
    flashAttn: true,
    ubatch: 512,
  };

  test("branch / layout / per-layer decomposition are exact", () => {
    const est = estimateKvCacheBytes(meta, opts);
    expect(est).not.toBeNull();
    if (est === null) return;
    expect(est.branch).toBe("swa");
    expect(est.attentionLayers).toBe(36);

    // 布局：padded 65536，per-stream pad(65536/3)=22016，3 streams
    expect(est.layout).toEqual({ slots: 3, streams: 3, cellsPerStream: 22016, totalCells: 66048 });
    // 滑窗：swaLimit = slidingWindow * (kvUnified ? slots : 1) + ub = 512*1 + 512 = 1024
    //   （kvUnified=false → 乘 1，不是 slots）
    //   swaCells = pad(min(22016,1024)) * streams = 1024*3 = 3072
    const swaLimit = 1024;
    const swaCells = 1024 * 3;
    expect(padKvCells(Math.min(22016, swaLimit)) * 3).toBe(swaCells);

    // 每层宽度：FA on → K = 4*256*2 = 2048，V = 4*256*2 = 2048 → 每 cell 4096 B
    const perCell = 4 * 256 * 2 + 4 * 256 * 2;
    expect(perCell).toBe(4096);

    // 每层二选一（不是相加）：llama.cpp 建两个 KV cache（全局一个、滑窗一个），
    // 一层只归属其中一个：
    //   全局层 = totalCells * 4096 = 66048 * 4096
    //   滑窗层 = swaCells * 4096 = 3072 * 4096
    //   合计 = 9*66048*4096 + 27*3072*4096
    //        = 594432*4096 + 82944*4096
    //        = 677376*4096 = 2774532096
    //   反过来验：2774532096 / 4096 = 677376 = 594432 + 82944 ✓
    const expectBytes = 9 * est.layout.totalCells * perCell + 27 * swaCells * perCell;
    expect(est.bytes).toBe(expectBytes);
    expect(est.bytes).toBe(2774532096);

    // 锁住「二选一」语义：pattern 全 false → 36 个全局层，每 cell 4096 B = 36*66048*4096；
    // 全 true → 36 个滑窗层，滑窗宽度（keyLengthSwa=valueLengthSwa=128）每 cell 2048 B
    // = 36*3072*2048。若滑窗层额外再算全局段，这两个数都会偏大。
    const allGlobal = estimateKvCacheBytes(
      { ...meta, slidingWindowPattern: Array(36).fill(false), keyLengthSwa: 256, valueLengthSwa: 256 },
      opts,
    );
    const allSwa = estimateKvCacheBytes(
      { ...meta, slidingWindowPattern: Array(36).fill(true), keyLengthSwa: 128, valueLengthSwa: 128 },
      opts,
    );
    expect(allGlobal).not.toBeNull();
    expect(allSwa).not.toBeNull();
    if (allGlobal === null || allSwa === null) return;
    expect(allGlobal.branch).toBe("swa");
    expect(allGlobal.bytes).toBe(36 * 66048 * 4096);
    expect(allGlobal.bytes).toBe(9739173888);
    expect(allSwa.branch).toBe("swa");
    expect(allSwa.bytes).toBe(36 * 3072 * 2048);
    expect(allSwa.bytes).toBe(226492416);
  });
});

// ---------- 6. MLA 分支 ----------

describe("KV estimate: MLA branch", () => {
  const meta = baseMeta({
    kvLoraRank: 512,
    keyLengthMla: 64,
    blockCount: 61,
    headCountKv: 1,
  });

  test("uses KV_LORA rank + RoPE dim, nKv = headCountKv (not headCount)", () => {
    const est = estimateKvCacheBytes(meta, KV_OPTS);
    expect(est).not.toBeNull();
    if (est === null) return;
    expect(est.branch).toBe("mla");
    expect(est.attentionLayers).toBe(61); // no per-layer array -> layersKv = blockCount

    // nKvMla = 1，ropeDim = 64，kLen = 512+64 = 576（keyLength 未给）
    // bpeK = q8_0 = 1.0625；layout (32768,1,false) totalCells = 32768
    const bpeK = 34 / 32;
    const totalCells = 32768;
    expect(est.bytes).toBe(Math.ceil(61 * totalCells * 1 * (512 + 64) * bpeK));
    // 写死：61 * 32768 * 576 * 1.0625 = 61 * 32768 * 612
    expect(est.bytes).toBe(61 * 32768 * 612);
  });

  test("per-layer kvLoraRank array drives the layer count (>0 entries)", () => {
    const meta2 = baseMeta({
      kvLoraRank: 512,
      keyLengthMla: 64,
      blockCount: 61,
      headCountKv: 1,
      headCountKvByLayer: [1, 0, 1, 1], // 3 个 > 0
    });
    const est = estimateKvCacheBytes(meta2, KV_OPTS);
    if (est === null) throw new Error("expected non-null");
    expect(est.branch).toBe("mla");
    expect(est.attentionLayers).toBe(3);
    expect(est.bytes).toBe(Math.ceil(3 * 32768 * 1 * 576 * (34 / 32)));
  });

  test("headCountKv missing falls back to 1, never to headCount", () => {
    const meta2 = baseMeta({ kvLoraRank: 512, keyLengthMla: 64, blockCount: 61, headCount: 24 });
    const est = estimateKvCacheBytes(meta2, KV_OPTS);
    if (est === null) throw new Error("expected non-null");
    // nKvMla = 1（headCountKv 缺失 → 1，而不是 24）
    expect(est.bytes).toBe(Math.ceil(61 * 32768 * 1 * 576 * (34 / 32)));
  });
});

// ---------- 7. GQA 分支 + headCountKvByLayer ----------

describe("KV estimate: GQA branch with per-layer kv heads", () => {
  const meta = baseMeta({
    blockCount: 4,
    headCount: 8,
    headCountKv: 2, // 标量回退值，逐层数组会覆盖它
    keyLength: 128,
    valueLength: 128,
    headDim: 128,
    headCountKvByLayer: [4, 2, 8, 1],
  });

  test("per-layer result equals the per-layer sum", () => {
    const est = estimateKvCacheBytes(meta, KV_OPTS);
    expect(est).not.toBeNull();
    if (est === null) return;
    expect(est.branch).toBe("gqa");
    expect(est.attentionLayers).toBe(4);

    const bpeK = 34 / 32;
    const bpeV = 34 / 32; // f16? 不，cacheTypeV=q8_0, FA on → 1.0625
    const cells = 32768;
    let sum = 0;
    for (const n of [4, 2, 8, 1]) sum += cells * (n * 128 * bpeK + n * 128 * bpeV);
    expect(est.bytes).toBe(Math.ceil(sum));
    // 写死：每层 per-cell = n*128*2*1.0625 = n*272；sum(n)=15 → 15*272*32768
    expect(est.bytes).toBe(15 * 272 * 32768);
  });
});

// ---------- 8. legacy 分支 ----------

describe("KV estimate: legacy fallback", () => {
  const meta = baseMeta({
    blockCount: 32,
    embeddingLength: 5120,
    headCount: 32,
    headCountKv: 4,
    // 不给 key/value length
  });

  test("hd = floor(embd/headCount), bytes = 2*nKv*hd*layersKv*totalCells*bpeK", () => {
    const est = estimateKvCacheBytes(meta, KV_OPTS);
    expect(est).not.toBeNull();
    if (est === null) return;
    expect(est.branch).toBe("legacy");
    expect(est.attentionLayers).toBe(32);

    const hd = Math.floor(5120 / 32); // 160
    const bpeK = 34 / 32;
    const cells = 32768;
    expect(est.bytes).toBe(Math.ceil(2 * 4 * hd * 32 * cells * bpeK));
    // 写死：2*4*160*32*32768*1.0625
    expect(est.bytes).toBe(2 * 4 * 160 * 32 * 32768 * (34 / 32));
  });

  test("missing headCount uses default hd = 128", () => {
    const meta2 = baseMeta({ blockCount: 10, embeddingLength: null, headCount: null, headCountKv: 2 });
    // 注意：canEstimateKv 需要 embeddingLength 或 key/value length 才为 true，这里 embeddingLength=null
    // 会落到 null；所以用 headCountKv + embeddingLength 构造
    const meta3 = baseMeta({ blockCount: 10, embeddingLength: 1024, headCount: null, headCountKv: 2 });
    const est = estimateKvCacheBytes(meta3, KV_OPTS);
    if (est === null) throw new Error("expected non-null");
    expect(est.branch).toBe("legacy");
    expect(est.bytes).toBe(Math.ceil(2 * 2 * 128 * 10 * 32768 * (34 / 32)));
    expect(meta2).toBeDefined();
  });
});

// ---------- 9. flashAttn=false 时 V 按 f16 定价 ----------

describe("KV estimate: flash attention off prices V as f16", () => {
  const meta = baseMeta({
    blockCount: 12,
    embeddingLength: 4096,
    headCount: 32,
    headCountKv: 4,
    keyLength: 128,
    valueLength: 128,
    headDim: 128,
  });

  const on = estimateKvCacheBytes(meta, { ...KV_OPTS, cacheTypeK: "f16", cacheTypeV: "q4_0", flashAttn: true });
  const off = estimateKvCacheBytes(meta, { ...KV_OPTS, cacheTypeK: "f16", cacheTypeV: "q4_0", flashAttn: false });

  test("FA on and off give different byte counts for the same meta", () => {
    expect(on).not.toBeNull();
    expect(off).not.toBeNull();
    if (on === null || off === null) return;
    expect(on.bytes).not.toBe(off.bytes);
  });

  test("FA off equals pricing V as f16 (2.0) instead of q4_0 (0.5625)", () => {
    expect(on).not.toBeNull();
    expect(off).not.toBeNull();
    if (on === null || off === null) return;

    const cells = 32768;
    const nKv = 4;
    const kLen = 128;
    const vLen = 128;
    const bpeK = 2; // f16
    // FA on: V @ 0.5625
    const onExpected = 12 * cells * (nKv * kLen * bpeK + nKv * vLen * 0.5625);
    // FA off: V @ 2.0
    const offExpected = 12 * cells * (nKv * kLen * bpeK + nKv * vLen * 2.0);
    expect(on.bytes).toBe(Math.ceil(onExpected));
    expect(off.bytes).toBe(Math.ceil(offExpected));
  });
});

// ---------- 10. canEstimateKv ----------

describe("canEstimateKv", () => {
  test("sufficient via kvLoraRank alone", () => {
    expect(canEstimateKv(baseMeta({ kvLoraRank: 512 }))).toBe(true);
  });
  test("sufficient via keyLength + valueLength", () => {
    expect(canEstimateKv(baseMeta({ keyLength: 128, valueLength: 128 }))).toBe(true);
  });
  test("sufficient via embeddingLength + headCount", () => {
    expect(canEstimateKv(baseMeta({ embeddingLength: 5120, headCount: 32 }))).toBe(true);
  });
  test("sufficient via embeddingLength + headCountKv", () => {
    expect(canEstimateKv(baseMeta({ embeddingLength: 5120, headCountKv: 4 }))).toBe(true);
  });
  test("insufficient -> false, and estimate returns null", () => {
    const meta = baseMeta({ blockCount: 32 });
    expect(canEstimateKv(meta)).toBe(false);
    expect(estimateKvCacheBytes(meta, KV_OPTS)).toBeNull();
  });
  test("ctxTokens <= 0 returns null even when estimable", () => {
    const meta = baseMeta({ keyLength: 128, valueLength: 128 });
    expect(estimateKvCacheBytes(meta, { ...KV_OPTS, ctxTokens: 0 })).toBeNull();
    expect(estimateKvCacheBytes(meta, { ...KV_OPTS, ctxTokens: -5 })).toBeNull();
  });
});

// ---------- 11. estimateComputeBufferBytes ----------

describe("estimateComputeBufferBytes", () => {
  const meta = baseMeta({ embeddingLength: 5120, vocabSize: 131072 });

  test("full formula, no tensor split, parallel 1", () => {
    // ub=512, par=1, vocab=131072, embd=5120
    // outBuffer = 131072*1*4 = 524288（每 slot 一个输出 token 的 logits，不乘 ubatch）
    // actScratch = 8*5120*512*4 = 83886080
    // raw = 83886080 + 524288 = 84410368
    // -> ceil(84410368 * 1.15) = ceil(97071923.2) = 97071924
    const got = estimateComputeBufferBytes(meta, { ubatch: 512, parallel: 1, tensorSplit: false });
    expect(got).toBe(97071924);
  });

  test("tensor split doubles both out buffer and act scratch, parallel 3", () => {
    // par=3, tensorSplit=true
    // raw = 2*(83886080 + 131072*3*4) = 2*(83886080 + 1572864) = 170917888
    // -> ceil(170917888*1.15) = ceil(196555571.2) = 196555572
    const got = estimateComputeBufferBytes(meta, { ubatch: 512, parallel: 3, tensorSplit: true });
    expect(got).toBe(196555572);
  });

  test("no tensor split: one out buffer per slot, not per (par-1)", () => {
    // par=3, tensorSplit=false
    // raw = 83886080 + 131072*3*4 = 83886080 + 1572864 = 85458944
    // -> ceil(85458944*1.15) = 98277785.6 -> 98277786
    const got = estimateComputeBufferBytes(meta, { ubatch: 512, parallel: 3, tensorSplit: false });
    expect(got).toBe(98277786);
    // tensorSplit 与否结果不同
    expect(got).not.toBe(estimateComputeBufferBytes(meta, { ubatch: 512, parallel: 3, tensorSplit: true }));
  });

  test("opts.vocabSize overrides meta.vocabSize", () => {
    // opts vocab=1000, ub=512, par=1, tensorSplit=false
    // outBuffer = 1000*1*4 = 4000; actScratch = 83886080
    // raw = 83890080 -> ceil(83890080*1.15) = 96473592
    const got = estimateComputeBufferBytes(meta, { ubatch: 512, parallel: 1, tensorSplit: false, vocabSize: 1000 });
    expect(got).toBe(96473592);
    // 与 meta vocab 的 97071924 不同（vocab 参与计算）
    expect(got).not.toBe(97071924);
  });

  test("missing vocabSize continues with outputBuffer = 0 (as long as embd > 0)", () => {
    const m = baseMeta({ embeddingLength: 5120, vocabSize: null });
    // actScratch = 8*5120*512*4 = 83886080 -> ceil(83886080*1.15) = 96468992
    expect(estimateComputeBufferBytes(m, { ubatch: 512, parallel: 1, tensorSplit: false })).toBe(96468992);
  });

  test("missing embeddingLength -> 0", () => {
    const m = baseMeta({ embeddingLength: null, vocabSize: 131072 });
    expect(estimateComputeBufferBytes(m, { ubatch: 512, parallel: 1, tensorSplit: false })).toBe(0);
  });

  test("parallel clamps to >= 1", () => {
    const got = estimateComputeBufferBytes(meta, { ubatch: 512, parallel: 0, tensorSplit: false });
    expect(got).toBe(97071924);
  });
});

// ---------- 12. computeBufferCtxBytes ----------

describe("computeBufferCtxBytes", () => {
  const f16Meta = baseMeta({ embeddingLength: 5120 });
  const ctx = 8192;

  test("FA on, f16 KV: KQ mask perTok = ub*2*3.5", () => {
    // FA on 基础速率 = ub*2*3.5 = 3584；f16 不含量化反量化暂存
    // -> 3584 * 8192 = 29360128
    const got = computeBufferCtxBytes(f16Meta, {
      ctxTokens: ctx,
      ubatch: 512,
      cacheTypeKv: "f16",
      layerSplit: false,
      flashAttn: true,
    });
    expect(got).toBe(3584 * 8192);
    expect(got).toBe(29360128);
  });

  test("FA off, f16 KV: score matrix perTok = headCount*ubatch*5", () => {
    // f16Meta 没给 headCount → 默认 8：perTok = 8*512*5 = 20480
    // -> 20480 * 8192 = 167772160
    const got = computeBufferCtxBytes(f16Meta, {
      ctxTokens: ctx,
      ubatch: 512,
      cacheTypeKv: "f16",
      layerSplit: false,
      flashAttn: false,
    });
    expect(got).toBe(8 * 512 * 5 * 8192);
    expect(got).toBe(167772160);
  });

  test("q8_0 path adds 2.25 * n_embd * (ub/512) dequant scratch on top of the base rate", () => {
    // FA on: perTok = 3584 + 2.25*5120 = 15104；q8_0 → 1.0625 < 2
    // -> 15104 * 8192 = 123731968
    const got = computeBufferCtxBytes(f16Meta, {
      ctxTokens: ctx,
      ubatch: 512,
      cacheTypeKv: "q8_0",
      layerSplit: false,
      flashAttn: true,
    });
    expect(got).toBe((3584 + 11520) * 8192);
    expect(got).toBe(123731968);
  });

  test("layerSplit=true adds 3 * maskRate * ctx over false", () => {
    const base = computeBufferCtxBytes(f16Meta, {
      ctxTokens: ctx,
      ubatch: 512,
      cacheTypeKv: "f16",
      layerSplit: false,
      flashAttn: true,
    });
    const split = computeBufferCtxBytes(f16Meta, {
      ctxTokens: ctx,
      ubatch: 512,
      cacheTypeKv: "f16",
      layerSplit: true,
      flashAttn: true,
    });
    const maskRate = 512 * 2 * 1.5;
    expect(split).toBe(base + 3 * maskRate * ctx);
  });

  test("layerSplit=true adds 3 * maskRate * ctx over false (quantized path too)", () => {
    const base = computeBufferCtxBytes(f16Meta, {
      ctxTokens: ctx,
      ubatch: 512,
      cacheTypeKv: "q8_0",
      layerSplit: false,
      flashAttn: true,
    });
    const split = computeBufferCtxBytes(f16Meta, {
      ctxTokens: ctx,
      ubatch: 512,
      cacheTypeKv: "q8_0",
      layerSplit: true,
      flashAttn: true,
    });
    const maskRate = 512 * 2 * 1.5;
    expect(split).toBe(base + 3 * maskRate * ctx);
  });

  test("MLA uses 1.25 per n_embd for dequant, not 2.25", () => {
    const mlaMeta = baseMeta({ embeddingLength: 5120, kvLoraRank: 512 });
    const perTok = 3584 + 1.25 * 5120 * (512 / 512); // 3584 + 6400 = 9984
    const got = computeBufferCtxBytes(mlaMeta, {
      ctxTokens: ctx,
      ubatch: 512,
      cacheTypeKv: "q8_0",
      layerSplit: false,
      flashAttn: true,
    });
    expect(got).toBe(Math.ceil(perTok * ctx));
    expect(got).toBe(9984 * 8192);
    // 且小于非 MLA 的 2.25 速率
    expect(got).toBeLessThan(
      computeBufferCtxBytes(baseMeta({ embeddingLength: 5120 }), {
        ctxTokens: ctx,
        ubatch: 512,
        cacheTypeKv: "q8_0",
        layerSplit: false,
        flashAttn: true,
      }),
    );
  });

  test("ubatch scales both the base rate and the quantized dequant rate", () => {
    // FA on, ub=1024: perTok = 1024*2*3.5 + 2.25*5120*2 = 7168 + 23040 = 30208
    const got = computeBufferCtxBytes(f16Meta, {
      ctxTokens: ctx,
      ubatch: 1024,
      cacheTypeKv: "q8_0",
      layerSplit: false,
      flashAttn: true,
    });
    expect(got).toBe(30208 * 8192);
  });

  test("ctxTokens <= 0 -> 0", () => {
    expect(
      computeBufferCtxBytes(f16Meta, { ctxTokens: 0, ubatch: 512, cacheTypeKv: "f16", layerSplit: false, flashAttn: true }),
    ).toBe(0);
    expect(
      computeBufferCtxBytes(f16Meta, { ctxTokens: -1, ubatch: 512, cacheTypeKv: "f16", layerSplit: false, flashAttn: true }),
    ).toBe(0);
  });
});

// ---------- 13. usableDeviceBytes ----------

describe("usableDeviceBytes", () => {
  const GiB = 1024 ** 3;
  test("absolute reserve when total is known", () => {
    // 20GiB free / 24GiB total → 20GiB - 0.03*24GiB
    const want = 20 * 1024 ** 3 - 0.03 * 24 * 1024 ** 3;
    expect(usableDeviceBytes(20 * 1024 ** 3, 24 * 1024 ** 3)).toBe(Math.floor(want));
  });
  test("total = 0 falls back to free * 0.97", () => {
    expect(usableDeviceBytes(8 * 1024 ** 3, 0)).toBe(Math.floor(0.97 * 8 * 1024 ** 3));
  });
  test("free smaller than the reserve clamps to 0, never negative", () => {
    expect(usableDeviceBytes(100, 24 * GiB)).toBe(0);
  });
  test("custom fraction is honored", () => {
    expect(usableDeviceBytes(1000, 0, 0.5)).toBe(500);
    expect(usableDeviceBytes(1000, 1000, 0.5)).toBe(500);
  });
  test("default fraction equals VRAM_FIT_FRACTION", () => {
    expect(VRAM_FIT_FRACTION).toBe(0.97);
  });
});

// ---------- 14. modelFootprintBytes ----------

describe("modelFootprintBytes", () => {
  const GiB = 1024 ** 3;
  test("CPU, no mmproj, one device: weights + compute buffer only", () => {
    expect(modelFootprintBytes({ weightsBytes: 2 * GiB, hasGpu: false, computeBufferBytes: 123456 })).toBe(
      2 * GiB + 123456,
    );
  });
  test("GPU adds the CUDA context reserve, mmproj adds its 1.4x safety margin", () => {
    expect(
      modelFootprintBytes({ weightsBytes: 2 * GiB, mmprojBytes: 100 * 1024 * 1024, hasGpu: true, computeBufferBytes: 0 }),
    ).toBe(2 * GiB + 100 * 1024 * 1024 + CUDA_CONTEXT_RESERVE_BYTES + 0.4 * 100 * 1024 * 1024);
  });
  test("mmproj = null behaves like absent", () => {
    expect(modelFootprintBytes({ weightsBytes: 1000, mmprojBytes: null, hasGpu: true, computeBufferBytes: 0 })).toBe(
      1000 + CUDA_CONTEXT_RESERVE_BYTES,
    );
  });
  test("deviceCount = 3 adds two per-device pipeline overheads", () => {
    expect(
      modelFootprintBytes({
        weightsBytes: 2 * GiB,
        mmprojBytes: 100 * 1024 * 1024,
        hasGpu: true,
        deviceCount: 3,
        computeBufferBytes: 0,
      }),
    ).toBe(
      2 * GiB + 100 * 1024 * 1024 + CUDA_CONTEXT_RESERVE_BYTES + 0.4 * 100 * 1024 * 1024 +
        2 * PIPELINE_PER_DEVICE_OVERHEAD_BYTES,
    );
  });
  test("deviceCount < 1 clamps to one device", () => {
    expect(modelFootprintBytes({ weightsBytes: 1000, hasGpu: true, deviceCount: 0, computeBufferBytes: 0 })).toBe(
      1000 + CUDA_CONTEXT_RESERVE_BYTES,
    );
  });
});

// ---------- 15. heavierCacheType ----------

describe("heavierCacheType", () => {
  test("returns the type with the larger per-elem bytes", () => {
    expect(heavierCacheType("q8_0", "f16")).toBe("f16");
    expect(heavierCacheType("f16", "q4_0")).toBe("f16");
    expect(heavierCacheType("q4_0", "q8_0")).toBe("q8_0");
  });
  test("null maps to the f16 fallback (2.0); equal weight prefers the named side, null/null is f16", () => {
    // null 按 f16（2.0）定价，比 q4_0 (0.5625) 重，但 null 本身没有名字 → 落回 "f16"
    expect(heavierCacheType(null, "q4_0")).toBe("f16");
    expect(heavierCacheType("q4_0", null)).toBe("f16");
    // 同价（2.0 vs 2.0）→ 优先非 null 的一边
    expect(heavierCacheType(null, "f16")).toBe("f16");
    expect(heavierCacheType("f16", null)).toBe("f16");
    // 两边都 null → "f16"（下游需要可用的类型名，null 的定价本来就按 f16 走）
    expect(heavierCacheType(null, null)).toBe("f16");
    // 两边都是具体名字：更重的赢，同价取第一个
    expect(heavierCacheType("q8_0", "f16")).toBe("f16");
    expect(heavierCacheType("f16", "bf16")).toBe("f16");
    // null 输给更重的 f32 (4.0)
    expect(heavierCacheType(null, "f32")).toBe("f32");
  });
  test("equal pricing keeps k", () => {
    expect(heavierCacheType("f16", "bf16")).toBe("f16");
    expect(heavierCacheType("q4_0", "iq4_nl")).toBe("q4_0");
  });
});

// ---------- 16. fitContextToBudget ----------

// 与锚点 B 同一个 meta（Spark-X2.5-4B 的 swa 布局）
const SPARK_META: GgufModelMeta = (() => {
  const pattern: boolean[] = Array.from({ length: 36 }, (_, i) => (i + 1) % 4 !== 0);
  return baseMeta({
    blockCount: 36,
    embeddingLength: 2560,
    headCount: 16,
    headCountKv: 4,
    keyLength: 256,
    valueLength: 256,
    headDim: 256,
    slidingWindow: 512,
    slidingWindowPattern: pattern,
    vocabSize: 131072,
    contextLength: 1048576,
  });
})();

function fitInput(over: Partial<FitContextInput>): FitContextInput {
  // 把 undefined 从 over 里去掉，否则它会覆盖 base 的 minCtx 默认值（?? 不触发，best 变成 undefined）
  const clean = Object.fromEntries(Object.entries(over).filter(([, v]) => v !== undefined)) as Partial<FitContextInput>;
  return {
    meta: SPARK_META,
    budgetBytes: 4 * 1024 ** 3,
    footprintBytes: 1 * 1024 ** 3,
    requestedCtx: 32768,
    minCtx: MIN_FIT_CTX,
    parallel: 1,
    kvUnified: false,
    cacheTypeK: "f16",
    cacheTypeV: "f16",
    flashAttn: true,
    ubatch: 512,
    layerSplit: false,
    ...clean,
  };
}

describe("fitContextToBudget", () => {
  test("insufficient metadata -> no-metadata, requested value returned as-is", () => {
    const r = fitContextToBudget(fitInput({ meta: baseMeta({ blockCount: 10 }), requestedCtx: 32768 }));
    expect(r.reason).toBe("no-metadata");
    expect(r.fits).toBe(false);
    expect(r.ctxTokens).toBe(32768);
    expect(r.kvBytes).toBe(0);
    expect(r.ctxComputeBytes).toBe(0);
    expect(r.totalBytes).toBe(0);
  });

  test("requested fits -> requested-fits, fits true", () => {
    const r = fitContextToBudget(fitInput({ budgetBytes: 16 * 1024 ** 3 }));
    expect(r.reason).toBe("requested-fits");
    expect(r.fits).toBe(true);
    expect(r.ctxTokens).toBe(32768);
    expect(r.totalBytes).toBeLessThanOrEqual(16 * 1024 ** 3);
  });

  test("weights alone exceed budget -> weights-exceed-budget, fits false", () => {
    // footprint 4GiB >= budget 3GiB；requested 装不下，但根因是权重
    const r = fitContextToBudget(fitInput({ budgetBytes: 3 * 1024 ** 3, footprintBytes: 4 * 1024 ** 3 }));
    expect(r.reason).toBe("weights-exceed-budget");
    expect(r.fits).toBe(false);
    expect(r.ctxTokens).toBe(32768);
    expect(r.kvBytes).toBeGreaterThan(0);
  });

  test("tight budget forces a reduction: reduced, 256-aligned, one step over the budget", () => {
    // 预算 = footprint + total(4096) + 8KiB：minCtx(4096) 装得下，32768 装不下
    const in4096 = fitInput({ minCtx: 4096 });
    const at4096 =
      in4096.footprintBytes +
      (estimateKvCacheBytes(in4096.meta, { ctxTokens: 4096, parallel: 1, kvUnified: false, cacheTypeK: "f16", cacheTypeV: "f16", flashAttn: true, ubatch: 512 })?.bytes ?? 0) +
      computeBufferCtxBytes(in4096.meta, { ctxTokens: 4096, ubatch: 512, cacheTypeKv: heavierCacheType("f16", "f16"), layerSplit: false, flashAttn: true });
    const budget = at4096 + 8 * 1024;

    const r = fitContextToBudget(fitInput({ minCtx: 4096, budgetBytes: budget }));
    expect(r.reason).toBe("reduced");
    expect(r.fits).toBe(true);
    expect(r.ctxTokens).toBeLessThan(32768);
    expect(r.ctxTokens).toBeGreaterThanOrEqual(4096);
    expect(r.ctxTokens % KV_CELL_ALIGN).toBe(0);
    expect(r.totalBytes).toBeLessThanOrEqual(budget);

    // 再加一个 256 cell 就装不下：结果确实是二分能取到的最大值附近。
    // 二分找到的 raw best 落在 [best-255, best]（对齐向下 256 得到 best），
    // total 单调不减，所以 total(best-256) 也超预算。
    const totalAt = (c: number): number =>
      in4096.footprintBytes +
      (estimateKvCacheBytes(in4096.meta, { ctxTokens: c, parallel: 1, kvUnified: false, cacheTypeK: "f16", cacheTypeV: "f16", flashAttn: true, ubatch: 512 })?.bytes ?? 0) +
      computeBufferCtxBytes(in4096.meta, { ctxTokens: c, ubatch: 512, cacheTypeKv: "f16", layerSplit: false, flashAttn: true });
    expect(totalAt(r.ctxTokens + 256)).toBeGreaterThan(budget);
  });

  test("budget can't even hold the floor -> floor, fits false, ctx = minCtx", () => {
    const in4096 = fitInput({ minCtx: 4096 });
    const at4096 =
      in4096.footprintBytes +
      (estimateKvCacheBytes(in4096.meta, { ctxTokens: 4096, parallel: 1, kvUnified: false, cacheTypeK: "f16", cacheTypeV: "f16", flashAttn: true, ubatch: 512 })?.bytes ?? 0) +
      computeBufferCtxBytes(in4096.meta, { ctxTokens: 4096, ubatch: 512, cacheTypeKv: "f16", layerSplit: false, flashAttn: true });
    // requested(32768) 也装不下，且连 minCtx(4096) 都装不下
    const budget = at4096 - 1;

    const r = fitContextToBudget(fitInput({ minCtx: 4096, budgetBytes: budget }));
    expect(r.reason).toBe("floor");
    expect(r.fits).toBe(false);
    expect(r.ctxTokens).toBe(4096);
    expect(r.totalBytes).toBeGreaterThan(budget);
  });

  test("requested below the min is not raised", () => {
    const in2048 = fitInput({ requestedCtx: 2048, minCtx: 4096 });
    const at2048 =
      in2048.footprintBytes +
      (estimateKvCacheBytes(in2048.meta, { ctxTokens: 2048, parallel: 1, kvUnified: false, cacheTypeK: "f16", cacheTypeV: "f16", flashAttn: true, ubatch: 512 })?.bytes ?? 0) +
      computeBufferCtxBytes(in2048.meta, { ctxTokens: 2048, ubatch: 512, cacheTypeKv: "f16", layerSplit: false, flashAttn: true });
    const budget = at2048 + 1024;

    const r = fitContextToBudget(fitInput({ requestedCtx: 2048, minCtx: 4096, budgetBytes: budget }));
    expect(r.ctxTokens).toBe(2048);
    expect(r.fits).toBe(true);
    expect(r.reason).toBe("requested-fits");
  });
});

// ---------- 16b. 真实实测对照：Spark-X2.5-4B × llama-server（范围断言） ----------
// llama-server 打印的 KV + compute buffer 分配量（f16/f16、parallel 1）。这些常数是经验
// 拟合的，所以用范围 [实测×0.7, 实测×1.6] 断言（略偏保守，绝不允许系统性低估）。
describe("compute buffer vs real llama-server measurements (Spark-4B)", () => {
  const MiB = 1024 ** 2;
  const meta = baseMeta({
    blockCount: 36,
    embeddingLength: 2560,
    headCount: 16,
    headCountKv: 4,
    keyLength: 256,
    valueLength: 256,
    headDim: 256,
    slidingWindow: 512,
    slidingWindowPattern: Array.from({ length: 36 }, (_, i) => (i + 1) % 4 !== 0), // 3,7,…,35 为全局层
    vocabSize: 131072,
  });

  const cases: Array<{ ctx: number; ubatch: number; flashAttn: boolean; measured: number; label: string }> = [
    { ctx: 4096, ubatch: 512, flashAttn: false, measured: 212860928, label: "203 MiB" },
    { ctx: 16384, ubatch: 512, flashAttn: false, measured: 724566016, label: "691 MiB" }, // 668 MiB
    { ctx: 16384, ubatch: 1024, flashAttn: false, measured: 1350565888, label: "1288 MiB" }, // 1241 MiB
    { ctx: 16384, ubatch: 512, flashAttn: true, measured: 96468992, label: "92 MiB" }, // 92 MiB
  ];

  for (const c of cases) {
    test(`ctx=${c.ctx} ubatch=${c.ubatch} FA ${c.flashAttn ? "on" : "off"} falls within [0.7, 1.6] × measured`, () => {
      const total =
        estimateComputeBufferBytes(meta, { ubatch: c.ubatch, parallel: 1, tensorSplit: false }) +
        computeBufferCtxBytes(meta, {
          ctxTokens: c.ctx,
          ubatch: c.ubatch,
          cacheTypeKv: "f16",
          layerSplit: false,
          flashAttn: c.flashAttn,
        });
      const ratio = total / c.measured;
      console.log(
        `[实测对照] ${c.label} (ctx=${c.ctx}, ubatch=${c.ubatch}, FA ${c.flashAttn ? "on" : "off"}): ` +
          `预测 ${total} (${(total / MiB).toFixed(1)} MiB), 实测 ${c.measured} (${(c.measured / MiB).toFixed(1)} MiB), 比值 ${ratio.toFixed(2)}`,
      );
      expect(total).toBeGreaterThanOrEqual(c.measured * 0.7);
      expect(total).toBeLessThanOrEqual(c.measured * 1.6);
    });
  }

  test("FA off is at least 5× the FA on ctx-linear part (order-of-magnitude gap)", () => {
    // 锁住「flash attention 开关是数量级差异」：关掉时注意力分数矩阵要完整物化
    // （heads × ubatch × 上下文），开着时只需要一个 KQ mask。
    // 如果谁把这个参数删掉，让 FA on 也按 mask 算，这条就会拦住。
    const off = computeBufferCtxBytes(meta, {
      ctxTokens: 16384,
      ubatch: 512,
      cacheTypeKv: "f16",
      layerSplit: false,
      flashAttn: false,
    });
    const on = computeBufferCtxBytes(meta, {
      ctxTokens: 16384,
      ubatch: 512,
      cacheTypeKv: "f16",
      layerSplit: false,
      flashAttn: true,
    });
    const ratio = off / on;
    console.log(`[实测对照] FA off/on 比值（ctx 线性部分）: ${ratio.toFixed(2)}×`);
    expect(ratio).toBeGreaterThanOrEqual(5);
  });
});

// ---------- 16c. KV 实测对照：Spark-4B（精确值，逐字节锁住） ----------
// llama-server 打印的 KV cache 分配量（f16/f16、FA on、parallel 1、kv-unified=false）：
//   全局层 9 × 4096×4096 + 滑窗层 27 × 1024×4096 = 144 + 108 = 252 MiB
// 每 cell = headCountKv×keyLength×2 + headCountKv×valueLength×2 = 4096 字节。
describe("KV vs real llama-server measurements (Spark-4B, exact)", () => {
  const meta = baseMeta({
    blockCount: 36,
    embeddingLength: 2560,
    headCount: 16,
    headCountKv: 4,
    keyLength: 256,
    valueLength: 256,
    headDim: 256,
    slidingWindow: 512,
    slidingWindowPattern: Array.from({ length: 36 }, (_, i) => (i + 1) % 4 !== 0),
    vocabSize: 131072,
  });

  test("ctx=4096, ubatch=512 → 252 MiB (9×4096×4096 + 27×1024×4096)", () => {
    const est = estimateKvCacheBytes(meta, {
      ctxTokens: 4096,
      parallel: 1,
      kvUnified: false,
      cacheTypeK: "f16",
      cacheTypeV: "f16",
      flashAttn: true,
      ubatch: 512,
    });
    expect(est).not.toBeNull();
    if (est === null) return;
    expect(est.branch).toBe("swa");
    expect(est.bytes).toBe(264241152);
  });

  test("ctx=16384, ubatch=512 → 684 MiB (9×16384×4096 + 27×1024×4096)", () => {
    const est = estimateKvCacheBytes(meta, {
      ctxTokens: 16384,
      parallel: 1,
      kvUnified: false,
      cacheTypeK: "f16",
      cacheTypeV: "f16",
      flashAttn: true,
      ubatch: 512,
    });
    expect(est).not.toBeNull();
    if (est === null) return;
    expect(est.bytes).toBe(717225984);
  });

  test("ctx=16384, ubatch=1024 → 738 MiB (9×16384×4096 + 27×1536×4096) — sliding cells track ubatch", () => {
    // 滑窗 cell 数 = slidingWindow + ubatch = 512 + 1024 = 1536（随 ubatch 变）
    const est = estimateKvCacheBytes(meta, {
      ctxTokens: 16384,
      parallel: 1,
      kvUnified: false,
      cacheTypeK: "f16",
      cacheTypeV: "f16",
      flashAttn: true,
      ubatch: 1024,
    });
    expect(est).not.toBeNull();
    if (est === null) return;
    expect(est.bytes).toBe(773849088);
    expect(est.layout.cellsPerStream).toBe(16384);
    expect(est.layout.streams).toBe(1);
  });
});

// ---------- 17. 真实场景回归：8 GiB 卡 + 锚点 B 的 Spark-4B ----------

describe("fitContextToBudget: real-scenario regression (Spark-4B on 8 GiB)", () => {
  const GiB = 1024 ** 3;
  const meta = SPARK_META;
  const weightsBytes = 2398000000; // ~2.29 GiB
  const computeBufferBytes = estimateComputeBufferBytes(meta, { ubatch: 512, parallel: 3, tensorSplit: false });
  const footprint = modelFootprintBytes({ weightsBytes, hasGpu: true, deviceCount: 1, computeBufferBytes });
  const budget = usableDeviceBytes(8 * GiB, 8 * GiB); // 8GiB 卡，full 占用
  const requestedCtx = 1048576;

  const input: FitContextInput = {
    meta,
    budgetBytes: budget,
    footprintBytes: footprint,
    requestedCtx,
    minCtx: MIN_FIT_CTX,
    parallel: 3,
    kvUnified: false,
    cacheTypeK: "f16",
    cacheTypeV: "f16",
    flashAttn: true,
    ubatch: 512,
    layerSplit: false,
  };

  const r = fitContextToBudget(input);
  console.log(
    `[T3b regression] ctxTokens=${r.ctxTokens} totalBytes=${r.totalBytes} ` +
      `(kv=${r.kvBytes}, ctxCompute=${r.ctxComputeBytes}, footprint=${footprint}, budget=${budget}, reason=${r.reason})`,
  );

  test("requesting 1M ctx on an 8GiB card reduces to a fitting 256-aligned window", () => {
    expect(r.reason).toBe("reduced");
    expect(r.fits).toBe(true);
    expect(r.ctxTokens % 256).toBe(0);
    expect(r.ctxTokens).toBeGreaterThan(MIN_FIT_CTX);
    expect(r.ctxTokens).toBeLessThan(requestedCtx);
    expect(r.totalBytes).toBeLessThanOrEqual(budget);
  });
});

// ---------- 18. resolveBudgetBytes ----------

describe("resolveBudgetBytes", () => {
  const GiB = 1024 ** 3;

  test("discrete GPU: usableDeviceBytes over free vram, basis vram", () => {
    // 20 GiB free / 24 GiB total → 20GiB - 0.03*24GiB（绝对预留）
    const want = Math.floor(20 * GiB - 0.03 * 24 * GiB);
    // vram 分支：overflow = systemFree * 0.6
    expect(resolveBudgetBytes({ hasGpu: true, vramFreeBytes: 20 * GiB, vramTotalBytes: 24 * GiB, systemFreeBytes: 64 * GiB, systemTotalBytes: 128 * GiB, unifiedMemory: false, cpuThreads: 8 })).toEqual({ budgetBytes: want, basis: "vram", overflowBytes: Math.floor(64 * GiB * SYSTEM_MEMORY_BUDGET_RATIO) });
  });

  test("discrete GPU with vramFreeBytes null does NOT fall into the vram branch", () => {
    const r = resolveBudgetBytes({ hasGpu: true, vramFreeBytes: null, vramTotalBytes: 24 * GiB, systemFreeBytes: 64 * GiB, systemTotalBytes: 128 * GiB, unifiedMemory: false, cpuThreads: 8 });
    expect(r.basis).toBe("system");
    expect(r.budgetBytes).toBe(Math.floor(64 * GiB * SYSTEM_MEMORY_BUDGET_RATIO));
    expect(r.overflowBytes).toBe(0); // 非 vram 分支没有第二层
  });

  test("unified memory: 0.75 of system total, basis unified (even with a discrete GPU probed)", () => {
    expect(UNIFIED_MEMORY_BUDGET_RATIO).toBe(0.75);
    const r = resolveBudgetBytes({ hasGpu: true, vramFreeBytes: 8 * GiB, vramTotalBytes: 0, systemFreeBytes: 20 * GiB, systemTotalBytes: 64 * GiB, unifiedMemory: true, cpuThreads: 10 });
    expect(r).toEqual({ budgetBytes: Math.floor(64 * GiB * 0.75), basis: "unified", overflowBytes: 0 });
  });

  test("pure CPU: 0.6 of currently-free system memory, basis system", () => {
    expect(SYSTEM_MEMORY_BUDGET_RATIO).toBe(0.6);
    const r = resolveBudgetBytes({ hasGpu: false, vramFreeBytes: null, vramTotalBytes: null, systemFreeBytes: 16 * GiB, systemTotalBytes: 32 * GiB, unifiedMemory: false, cpuThreads: 16 });
    expect(r).toEqual({ budgetBytes: Math.floor(16 * GiB * 0.6), basis: "system", overflowBytes: 0 });
  });
});

// ---------- 19. planLlamaLaunch ----------

describe("planLlamaLaunch", () => {
  const GiB = 1024 ** 3;

  // 锚点 B：Spark-X2.5-4B（swa，contextLength 1M）
  const spark = SPARK_META;
  const sparkWeights = 2_398_000_000; // ~2.29 GiB

  // 锚点 A：Qwen3.8-27B（hybrid-ssm，contextLength 256K，65 层）
  const qwen = baseMeta({
    blockCount: 65,
    embeddingLength: 5120,
    headCount: 24,
    headCountKv: 4,
    keyLength: 256,
    valueLength: 256,
    headDim: 256,
    fullAttentionInterval: 4,
    ssmInnerSize: 6144,
    contextLength: 262144,
    vocabSize: 151936,
  });
  const qwenWeights = 15_548_875_000; // ~14.5 GiB

  const gpu = (freeGiB: number, totalGiB: number, over?: { sysFreeGiB?: number; sysTotalGiB?: number }) => ({
    hasGpu: true,
    vramFreeBytes: freeGiB * GiB,
    vramTotalBytes: totalGiB * GiB,
    systemFreeBytes: (over?.sysFreeGiB ?? 32) * GiB,
    systemTotalBytes: (over?.sysTotalGiB ?? 64) * GiB,
    unifiedMemory: false,
    cpuThreads: 8,
  });

  const cpu = () => ({
    hasGpu: false,
    vramFreeBytes: null,
    vramTotalBytes: null,
    systemFreeBytes: 32 * GiB,
    systemTotalBytes: 64 * GiB,
    unifiedMemory: false,
    cpuThreads: 16,
  });

  const codes = (plan: ReturnType<typeof planLlamaLaunch>) => plan.reasons.map((r) => r.code);

  test("small model, roomy 128GiB card: fits, no layer override, native context window", () => {
    // 1M 原生窗口：KV 光 f16 就要 38.7GiB，加上 FA 关闭计价的 ctx 线性 compute buffer（≈40GiB），
    // 48GiB 装不下，128GiB 才够
    const plan = planLlamaLaunch({ meta: spark, weightsBytes: sparkWeights, hardware: gpu(128, 128) });
    console.log(`[T3c #2] ctxTokens=${plan.ctxTokens} totalBytes=${plan.estimates.totalBytes} budget=${plan.estimates.budgetBytes} reasons=${codes(plan).join(",")}`);
    expect(plan.fits).toBe(true);
    expect(plan.gpuLayers).toBeNull();
    // 装得下就用「请求窗口」= 模型元数据的 contextLength（1M）
    expect(plan.ctxTokens).toBe(spark.contextLength ?? 8192);
    expect(plan.ctxTokens).toBe(1048576);
    expect(plan.ctxPerSlot).toBe(plan.ctxTokens); // parallel=1 → kvUnified=false，但整窗口归它
    expect(plan.estimates.totalBytes).toBeLessThanOrEqual(plan.estimates.budgetBytes);
    expect(codes(plan)).toContain("budget.vram");
    expect(codes(plan)).toContain("ctx.native");
    expect(codes(plan)).not.toContain("ctx.reduced");
  });

  test("same model on 24GiB: 1M 装不下，降到装得下的 256 对齐窗口（ctx.reduced）", () => {
    const plan = planLlamaLaunch({ meta: spark, weightsBytes: sparkWeights, hardware: gpu(24, 24) });
    expect(plan.ctxTokens).toBeLessThan(spark.contextLength!);
    expect(plan.ctxTokens % 256).toBe(0);
    expect(plan.fits).toBe(true);
    expect(codes(plan)).toContain("ctx.reduced");
  });

  test("same model on 8GiB: window reduced to a 256-aligned value that fits", () => {
    const plan = planLlamaLaunch({ meta: spark, weightsBytes: sparkWeights, hardware: gpu(8, 8) });
    console.log(`[T3c #3] ctxTokens=${plan.ctxTokens} totalBytes=${plan.estimates.totalBytes} budget=${plan.estimates.budgetBytes} reasons=${codes(plan).join(",")}`);
    expect(plan.ctxTokens).toBeLessThan(spark.contextLength!);
    expect(plan.ctxTokens % 256).toBe(0);
    expect(plan.fits).toBe(true);
    expect(plan.gpuLayers).toBeNull();
    expect(codes(plan)).toContain("ctx.reduced");
  });

  test("user-specified ctx is never shrunk, even when it doesn't fit", () => {
    // 8GiB 卡：256K 的 KV(f16) ≈ 9.8GiB + FA 关闭计价的 ctx 线性 compute buffer ≈ 10.7GiB，
    // 加上权重/常驻开销共 ~23GiB > 预算 8.33GiB → 装不下
    const plan = planLlamaLaunch({
      meta: spark,
      weightsBytes: sparkWeights,
      hardware: gpu(8, 8),
      overrides: { ctxTokens: 262144 },
    });
    expect(plan.ctxTokens).toBe(262144); // 绝不被自动缩小
    expect(plan.fits).toBe(false);
    expect(codes(plan)).toContain("ctx.user");
    // detail 按规格携带 fit.fits（fitContextToBudget 把窗口降到装得下才 true；
    // 这里最终 plan.fits=false 才是用户那个 262144 的真实状态）
    const user = plan.reasons.find((r) => r.code === "ctx.user");
    expect(user?.detail?.["ctxTokens"]).toBe(262144);
    expect(typeof (user?.detail?.["fits"] as boolean)).toBe("boolean");

    // 对照：同一配置但权重足够大（10GiB），使得 footprint > 8GiB 卡预算（8.33GiB）→
    // fitContextToBudget 走 weights-exceed-budget 分支，detail.fits=false，
    // 证明「不被缩小」与「装不装得下」是两件独立的事。
    const big = planLlamaLaunch({
      meta: spark,
      weightsBytes: 10_000_000_000,
      hardware: gpu(8, 8, { sysFreeGiB: 0, sysTotalGiB: 4 }),
      overrides: { ctxTokens: 262144 },
    });
    expect(big.ctxTokens).toBe(262144);
    expect(big.fits).toBe(false);
    expect(big.reasons.find((r) => r.code === "ctx.user")?.detail?.["fits"]).toBe(false);
  });

  test("parallel=8, batch=4 → batch raised to 8; kv-unified vs split-per-slot", () => {
    const unified = planLlamaLaunch({
      meta: spark,
      weightsBytes: sparkWeights,
      hardware: gpu(24, 24),
      overrides: { parallel: 8, batch: 4 },
      supportsKvUnified: true,
    });
    expect(unified.batch).toBe(8);
    expect(unified.parallel).toBe(8);
    expect(unified.kvUnified).toBe(true);
    expect(unified.ctxPerSlot).toBe(unified.ctxTokens);
    expect(codes(unified)).toContain("batch.raised");
    expect(codes(unified)).toContain("kv.unified");
    expect(codes(unified)).not.toContain("kv.split-per-slot");

    const split = planLlamaLaunch({
      meta: spark,
      weightsBytes: sparkWeights,
      hardware: gpu(24, 24),
      overrides: { parallel: 8, batch: 4 },
      supportsKvUnified: false,
    });
    expect(split.kvUnified).toBe(false);
    expect(split.ctxPerSlot).toBe(Math.floor(split.ctxTokens / 8));
    expect(codes(split)).toContain("kv.split-per-slot");
    expect(codes(split)).not.toContain("kv.unified");
    // split-per-slot 的均分窗口更小 → 更省显存
    expect(split.ctxTokens).toBeLessThanOrEqual(unified.ctxTokens);
  });

  test("27B on 8GiB with 16GiB free system RAM: overflows to system memory, fits a reduced window, partial offload", () => {
    // Qwen3.8-27B：14.5 GiB 权重 + 256K 原生窗口，8 GiB 显存装不下。
    // 二级预算 = 显存 8.33 GiB + 溢出 floor(16GiB * 0.6) ≈ 18.02 GiB（总计 ≈26.35 GiB）。
    // 原生 256K 总占用 ≈34.6 GiB > 26.35 GiB → 二级预算装不下原生窗口，
    // 被拟合到一个更小的 256 对齐窗口（ctx.reduced），而不是原样返回原生 262144。
    // 这正是「装不下的时候更需要给一个拟合过的窗口」的本意。
    const plan = planLlamaLaunch({ meta: qwen, weightsBytes: qwenWeights, hardware: gpu(8, 8, { sysFreeGiB: 16, sysTotalGiB: 64 }) });
    console.log(`[T3c #7] ctxTokens=${plan.ctxTokens} gpuLayers=${plan.gpuLayers} fits=${plan.fits} overflowBytes=${plan.estimates.overflowBytes} totalBytes=${plan.estimates.totalBytes} budget=${plan.estimates.budgetBytes} reasons=${codes(plan).join(",")}`);
    expect(codes(plan)).toContain("budget.overflow-to-system");
    expect(plan.estimates.overflowBytes).toBeGreaterThan(0);
    expect(plan.fits).toBe(true);
    // 原生 256K 被拟合到更小、能放进「显存 + 溢出」预算的 256 对齐窗口
    expect(plan.ctxTokens).toBeLessThan(262144);
    expect(plan.ctxTokens % 256).toBe(0);
    expect(plan.ctxTokens).toBeGreaterThanOrEqual(MIN_FIT_CTX);
    expect(codes(plan)).toContain("ctx.reduced");
    // gpuLayers 仍按 GPU 预算算（8 GiB 显存装不下 27B 权重 → 极小，落在 0..65）
    expect(plan.gpuLayers).not.toBeNull();
    expect(Number.isInteger(plan.gpuLayers)).toBe(true);
    expect(plan.gpuLayers!).toBeGreaterThanOrEqual(0);
    expect(plan.gpuLayers!).toBeLessThanOrEqual(65);
    expect(codes(plan)).toContain("gpu.partial-offload");
  });

  test("27B on 8GiB but only 2GiB free system RAM: overflow isn't enough → doesn't fit, ctx.floor", () => {
    // 同样模型 + 同样 8 GiB 显存，但系统空闲只有 2 GiB → 二级预算（+1.2 GiB）也不够
    const plan = planLlamaLaunch({ meta: qwen, weightsBytes: qwenWeights, hardware: gpu(8, 8, { sysFreeGiB: 2, sysTotalGiB: 64 }) });
    console.log(`[T3c #7b] ctxTokens=${plan.ctxTokens} fits=${plan.fits} overflowBytes=${plan.estimates.overflowBytes} reasons=${codes(plan).join(",")}`);
    expect(plan.fits).toBe(false);
    // 没有溢出救活 → 不出现 overflow-to-system
    expect(codes(plan)).not.toContain("budget.overflow-to-system");
    expect(codes(plan)).toContain("ctx.floor");
  });

  test("pure CPU: no overflow-to-system (budget is already system memory)", () => {
    const plan = planLlamaLaunch({ meta: spark, weightsBytes: sparkWeights, hardware: cpu() });
    expect(plan.gpuLayers).toBe(0);
    expect(codes(plan)).toContain("gpu.none");
    expect(codes(plan)).toContain("budget.system");
    // 32GiB * 0.6 ≈ 19GiB 预算，Spark-4B 装得下
    expect(plan.fits).toBe(true);
    // 纯 CPU 预算本来就是内存，没有第二层 → 绝不出现 overflow-to-system
    expect(codes(plan)).not.toContain("budget.overflow-to-system");
    expect(plan.estimates.overflowBytes).toBe(0);
  });

  test("quantized V cache: default (unspecified) stays conservative, explicit on prices quantized V", () => {
    const q4Default = planLlamaLaunch({ meta: spark, weightsBytes: sparkWeights, hardware: gpu(24, 24), overrides: { cacheTypeV: "q4_0" } });
    const q4On = planLlamaLaunch({ meta: spark, weightsBytes: sparkWeights, hardware: gpu(24, 24), overrides: { cacheTypeV: "q4_0", flashAttn: true } });
    const q4Off = planLlamaLaunch({ meta: spark, weightsBytes: sparkWeights, hardware: gpu(24, 24), overrides: { cacheTypeV: "q4_0", flashAttn: false } });
    const f16 = planLlamaLaunch({ meta: spark, weightsBytes: sparkWeights, hardware: gpu(24, 24), overrides: { cacheTypeV: "f16" } });
    // 未显式指定（null → 默认开、预算按关）：保守行为保持（原断言不破）
    expect(q4Default.flashAttn).toBe(true); // 默认开
    expect(codes(q4Default)).toContain("fa.forced-on");
    expect(codes(q4Default)).toContain("fa.budget-conservative");
    expect(q4Default.estimates.kvBytes).toBe(f16.estimates.kvBytes);
    // 明确知道开着（overrides.flashAttn=true）：量化 V 按真实价格计，不再抬到 f16。
    // 用 estimateKvCacheBytes 在同一 ctx 下直接对比（两个 plan 拟合到的 ctx 不同，
    // 跨 plan 比 kvBytes 比的是「更大窗口 × 更便宜单价」vs「更小窗口 × 更贵单价」，
    // 方向不确定；同 ctx 比才能隔离 FA 定价这一个变量）。
    const sameCtx = 65536;
    const kvOnSame = estimateKvCacheBytes(spark, { ctxTokens: sameCtx, parallel: 1, kvUnified: false, cacheTypeK: "f16", cacheTypeV: "q4_0", flashAttn: true, ubatch: 512 })!;
    const kvF16Same = estimateKvCacheBytes(spark, { ctxTokens: sameCtx, parallel: 1, kvUnified: false, cacheTypeK: "f16", cacheTypeV: "f16", flashAttn: true, ubatch: 512 })!;
    expect(kvOnSame.bytes).toBeLessThan(kvF16Same.bytes);
    expect(q4On.flashAttn).toBe(true);
    expect(codes(q4On)).not.toContain("fa.budget-conservative");
    expect(codes(q4On)).not.toContain("fa.forced-on");
    // 明确知道关着（overrides.flashAttn=false）：量化 V 被 llama.cpp 退回 f16，预算按 f16 计
    expect(q4Off.flashAttn).toBe(false);
    expect(codes(q4Off)).toContain("fa.budget-conservative");
    expect(q4Off.estimates.kvBytes).toBe(f16.estimates.kvBytes);
    // f16 的 V 本来就不受 FA 开关影响：开与关的预算一致，也不出保守 reason
    expect(codes(f16)).not.toContain("fa.budget-conservative");
    expect(f16.estimates.kvBytes).toBe(q4Off.estimates.kvBytes);
  });

  test("insufficient metadata: ctx.no-metadata, no throw, ctx = requested", () => {
    const bare = baseMeta({ blockCount: 36 }); // key/value length、embedding、head 全 null
    const plan = planLlamaLaunch({ meta: bare, weightsBytes: sparkWeights, hardware: gpu(8, 8) });
    expect(codes(plan)).toContain("ctx.no-metadata");
    // 没有 contextLength → requested 退 8192，原样返回
    expect(plan.ctxTokens).toBe(8192);
  });

  test("reasons come out in decision order (budget before ctx)", () => {
    const plan = planLlamaLaunch({ meta: spark, weightsBytes: sparkWeights, hardware: gpu(8, 8) });
    const iBudget = codes(plan).indexOf("budget.vram");
    const iCtx = codes(plan).indexOf("ctx.reduced");
    expect(iBudget).toBeGreaterThanOrEqual(0);
    expect(iCtx).toBeGreaterThan(iBudget);
  });

  // ---------- T4d：预算按实测 FA 状态计价 ----------

  test("flashAttn=true: quantized V priced at its real rate and ctx-linear buffer takes the FA branch", () => {
    const on = planLlamaLaunch({ meta: spark, weightsBytes: sparkWeights, hardware: gpu(24, 24), overrides: { cacheTypeV: "q4_0", flashAttn: true } });
    const off = planLlamaLaunch({ meta: spark, weightsBytes: sparkWeights, hardware: gpu(24, 24), overrides: { cacheTypeV: "q4_0", flashAttn: false } });
    // 量化 V：FA 开 → 按 q4_0 的真实每元素字节数（0.5625）计，不被抬到 f16（2.0）。
    // 同一 ctx 下直接比（跨 plan 比 kvBytes 混入了窗口大小的变量，方向不确定）。
    const ctx = 65536;
    const kvOn = estimateKvCacheBytes(spark, { ctxTokens: ctx, parallel: 1, kvUnified: false, cacheTypeK: "f16", cacheTypeV: "q4_0", flashAttn: true, ubatch: 512 })!;
    const kvOff = estimateKvCacheBytes(spark, { ctxTokens: ctx, parallel: 1, kvUnified: false, cacheTypeK: "f16", cacheTypeV: "q4_0", flashAttn: false, ubatch: 512 })!;
    expect(kvOn.bytes).toBeLessThan(kvOff.bytes);
    // ctx 线性 compute buffer：FA 关时注意力分数矩阵 [heads, ubatch, n_kv] 全量物化，
    // FA 开时只有一块 KQ mask —— 同一 ctx 下差约一个数量级（实测 691 MiB vs 92 MiB @ ctx 16K）
    const ccOn = computeBufferCtxBytes(spark, { ctxTokens: ctx, ubatch: 512, cacheTypeKv: "f16", layerSplit: false, flashAttn: true });
    const ccOff = computeBufferCtxBytes(spark, { ctxTokens: ctx, ubatch: 512, cacheTypeKv: "f16", layerSplit: false, flashAttn: false });
    expect(ccOn).toBeGreaterThan(0);
    expect(ccOn).toBeLessThan(ccOff / 5);
    // FA 开能拟合到更大的窗口（总占用更小 → 同预算装得下更多）
    expect(on.ctxTokens).toBeGreaterThanOrEqual(off.ctxTokens);
    // 明确知道开着 → 不出保守 reason
    expect(codes(on)).not.toContain("fa.budget-conservative");
    expect(codes(on)).not.toContain("fa.forced-on");
    expect(codes(off)).toContain("fa.budget-conservative");
  });

  test("flashAttn=false / unspecified: conservative behavior unchanged", () => {
    const off = planLlamaLaunch({ meta: spark, weightsBytes: sparkWeights, hardware: gpu(8, 8), overrides: { flashAttn: false } });
    const unspecified = planLlamaLaunch({ meta: spark, weightsBytes: sparkWeights, hardware: gpu(8, 8) });
    // 显式 false 与未指定（null → 预算按关）都走保守计价：预算结果一致
    expect(off.flashAttn).toBe(false);
    expect(unspecified.flashAttn).toBe(true); // 默认开
    expect(unspecified.ctxTokens).toBe(off.ctxTokens); // 预算都按关 → 同窗口
    expect(unspecified.estimates.kvBytes).toBe(off.estimates.kvBytes);
    expect(unspecified.estimates.ctxComputeBytes).toBe(off.estimates.ctxComputeBytes);
    expect(codes(unspecified)).toContain("fa.forced-on");
    // 未指定 + f16 V：V 本来就是 f16，抬价不影响 → 不出保守 reason（原断言保持）
    expect(codes(unspecified)).not.toContain("fa.budget-conservative");
  });

  // T4e：同一 meta + 同一硬件，FA 开能拟合到至少 2 倍的总窗口（把用户实测的
  // 8GiB + Spark-4B + q8_0 KV 上「FA 关 72704 → FA 开 189696 ≈ 2.6×」锁成下限 2×）。
  test("T4e: 同一 meta + 硬件，flashAttn=true 的 ctxTokens ≥ 2× flashAttn=false", () => {
    // 用 q8_0 量化的 K/V（用户实测的场景），8GiB 独显，其余硬件条件一致。
    const common = { meta: spark, weightsBytes: sparkWeights, hardware: gpu(8, 8) };
    const off = planLlamaLaunch({ ...common, overrides: { cacheTypeK: "q8_0", cacheTypeV: "q8_0", flashAttn: false } });
    const on = planLlamaLaunch({ ...common, overrides: { cacheTypeK: "q8_0", cacheTypeV: "q8_0", flashAttn: true } });
    console.log(`[T4e] FA off ctxTokens=${off.ctxTokens} · FA on ctxTokens=${on.ctxTokens} · ratio=${(on.ctxTokens / off.ctxTokens).toFixed(2)}`);
    expect(off.ctxTokens).toBeGreaterThan(0);
    expect(on.ctxTokens).toBeGreaterThanOrEqual(off.ctxTokens * 2);
  });
});
