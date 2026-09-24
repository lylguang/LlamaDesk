/**
 * 启动显存估算核心（KV cache + compute buffer）+ 启动计划（launch planner）。
 *
 * 纯函数：输入 GGUF 元数据 + 硬件画像 + 用户启动参数，输出
 * 1. 「这块模型在这个上下文、这个并发下，KV cache 和 compute buffer 各要多少字节」（估算层）
 * 2. 「这台机器上该以什么参数启动它」（`planLlamaLaunch`，组装层）
 *
 * 不 import node:* / bun / electrobun，主进程与 webview 共用。
 */

import type { GgufModelMeta } from "./gguf";

// ---------- 1. KV cache 每元素字节数 ----------

const KV_BPE_TABLE: Record<string, number> = {
  f32: 4,
  f16: 2,
  bf16: 2,
  q8_0: 34 / 32, // 1.0625
  q5_1: 0.75,
  q5_0: 0.6875,
  q4_1: 0.625,
  q4_0: 0.5625,
  iq4_nl: 0.5625,
};

/** KV cache 量化类型名 → 每元素字节数；不认识 / null / 空串一律按 f16（2.0）保守定价。 */
export function kvBytesPerElem(name: string | null | undefined): number {
  if (name === null || name === undefined) return 2.0;
  const key = name.trim().toLowerCase();
  if (key === "") return 2.0;
  return KV_BPE_TABLE[key] ?? 2.0;
}

// ---------- 2. KV cell 布局 ----------

/** llama.cpp KV cache 的对齐粒度是 256，不是 512/1024。 */
export const KV_CELL_ALIGN = 256;

/** 向上对齐到 256 的倍数；<=0 给 0。 */
export function padKvCells(cells: number): number {
  if (!Number.isFinite(cells) || cells <= 0) return 0;
  return Math.ceil(cells / KV_CELL_ALIGN) * KV_CELL_ALIGN;
}

export type KvLayout = {
  slots: number;
  streams: number;
  cellsPerStream: number;
  totalCells: number;
};

export function kvCellLayout(ctxTokens: number, parallel: number, kvUnified: boolean): KvLayout {
  const slots = Math.max(1, Math.floor(parallel) || 1);
  const paddedCtx = padKvCells(ctxTokens);
  const streams = kvUnified ? 1 : slots;
  const cellsPerStream = kvUnified ? paddedCtx : padKvCells(Math.floor(paddedCtx / slots));
  return { slots, streams, cellsPerStream, totalCells: cellsPerStream * streams };
}

// ---------- 3. KV cache 估算 ----------

export type KvEstimateOpts = {
  ctxTokens: number;
  parallel: number;
  kvUnified: boolean;
  cacheTypeK: string | null;
  cacheTypeV: string | null;
  flashAttn: boolean;
  /** null 当 512（llama.cpp 默认 ubatch） */
  ubatch: number | null;
};

export type KvBranch = "mla" | "hybrid-ssm" | "swa" | "gqa" | "legacy";

export type KvEstimate = {
  bytes: number;
  branch: KvBranch;
  attentionLayers: number;
  layout: KvLayout;
};

/** 元数据够不够估算 KV（任一充分条件即可）。 */
export function canEstimateKv(meta: GgufModelMeta): boolean {
  if (meta.kvLoraRank != null) return true;
  if (meta.keyLength != null && meta.valueLength != null) return true;
  if (meta.embeddingLength != null && (meta.headCount != null || meta.headCountKv != null)) return true;
  return false;
}

/** flash attention 关闭时 llama.cpp 按模型里最宽的那一层分配 V，所以逐层宽度要补齐到最大值。 */
function maxKvValueWidth(meta: GgufModelMeta, valLen: number): number {
  if (meta.headCountKvByLayer !== null && meta.headCountKvByLayer.length > 0) {
    let maxN = 0;
    for (const n of meta.headCountKvByLayer) if (n > maxN) maxN = n;
    return maxN * valLen;
  }
  const n = meta.headCountKv ?? meta.headCount ?? 1;
  return n * valLen;
}

function headCountKvAt(meta: GgufModelMeta, l: number): number {
  const arr = meta.headCountKvByLayer;
  if (arr !== null) {
    if (l < arr.length) return arr[l]!;
  }
  return meta.headCountKv ?? meta.headCount ?? 1;
}

function isSwaLayer(meta: GgufModelMeta, l: number, layersKv: number): boolean {
  const pattern = meta.slidingWindowPattern;
  if (pattern !== null && pattern.length > 0) {
    // pattern 比 layersKv 短就循环取模
    return pattern[l % pattern.length] === true;
  }
  // 没有 pattern 时的启发式：前 max(1, floor(layersKv/4)) 层当全局，其余当滑窗
  const globalPrefix = Math.max(1, Math.floor(layersKv / 4));
  return l >= globalPrefix;
}

/**
 * 估算 KV cache 字节数。`canEstimateKv` 为 false 或 `ctxTokens <= 0` → 返回 null
 * （上层据此放弃自动拟合）。
 */
export function estimateKvCacheBytes(meta: GgufModelMeta, opts: KvEstimateOpts): KvEstimate | null {
  if (!canEstimateKv(meta) || opts.ctxTokens <= 0) return null;

  const layout = kvCellLayout(opts.ctxTokens, opts.parallel, opts.kvUnified);
  const { totalCells, cellsPerStream, slots } = layout;
  const layersKv = Math.max(1, (meta.blockCount ?? 1) - (meta.sharedKvLayers ?? 0));
  const nKv = meta.headCountKv ?? meta.headCount ?? 1;
  const bpeK = kvBytesPerElem(opts.cacheTypeK);
  // 关掉 flash attention 时 llama.cpp 不接受量化的 V cache，会退回 f16，
  // 所以 V 必须按 max(量化定价, f16) 预算，否则因崩溃重试关掉 FA 就会 OOM。
  const bpeV = opts.flashAttn ? kvBytesPerElem(opts.cacheTypeV) : Math.max(kvBytesPerElem(opts.cacheTypeV), 2.0);
  const ub = opts.ubatch ?? 512;
  const keyLen = meta.keyLength ?? meta.headDim ?? 128;
  const valLen = meta.valueLength ?? meta.headDim ?? 128;

  let bytes: number;
  let branch: KvBranch;
  let attentionLayers: number;

  // 分支 1：MLA（只缓存一路 K，没有独立的 V）
  if (meta.kvLoraRank != null) {
    branch = "mla";
    const nKvMla = meta.headCountKv ?? 1; // 缺失时回退 1，绝不回退 headCount
    const ropeDim = meta.keyLengthMla ?? 64;
    const kLen = meta.keyLength ?? (meta.kvLoraRank + ropeDim);
    const arr = meta.headCountKvByLayer;
    const mlaLayers = arr !== null ? arr.filter((x): x is number => x > 0).length : layersKv;
    attentionLayers = mlaLayers;
    bytes = mlaLayers * totalCells * nKvMla * kLen * bpeK;
  } else if (
    meta.ssmInnerSize != null &&
    meta.fullAttentionInterval != null &&
    meta.fullAttentionInterval > 0
  ) {
    // 分支 2：Mamba/注意力混合架构（只有一部分层有 KV）
    branch = "hybrid-ssm";
    const attnLayers = Math.ceil((meta.blockCount ?? 1) / meta.fullAttentionInterval);
    attentionLayers = attnLayers;
    const vWidth = opts.flashAttn ? nKv * valLen : maxKvValueWidth(meta, valLen);
    bytes = attnLayers * totalCells * (nKv * keyLen * bpeK + vWidth * bpeV);
  } else if (meta.slidingWindow != null && meta.slidingWindow > 0 && meta.keyLength != null && meta.valueLength != null) {
    // 分支 3：滑动窗口注意力
    branch = "swa";
    attentionLayers = layersKv;
    const kLenSwa = meta.keyLengthSwa ?? keyLen;
    const vLenSwa = meta.valueLengthSwa ?? valLen;
    const swaLimit = meta.slidingWindow * (opts.kvUnified ? slots : 1) + ub;
    const swaCellsTotal = padKvCells(Math.min(cellsPerStream, swaLimit)) * layout.streams;
    // 每层二选一：全局层只进全局 cache（totalCells × 完整宽度），滑窗层只进
    // 滑窗 cache（swaCellsTotal × 滑窗宽度）——llama.cpp 建两个 KV cache，
    // 一层只归属其中一个，绝不两份相加。
    let sum = 0;
    for (let l = 0; l < layersKv; l++) {
      const nKvL = headCountKvAt(meta, l);
      if (isSwaLayer(meta, l, layersKv)) {
        const vWs = opts.flashAttn ? nKvL * vLenSwa : maxKvValueWidth(meta, vLenSwa);
        sum += swaCellsTotal * (nKvL * kLenSwa * bpeK + vWs * bpeV);
      } else {
        const vW = opts.flashAttn ? nKvL * valLen : maxKvValueWidth(meta, valLen);
        sum += totalCells * (nKvL * keyLen * bpeK + vW * bpeV);
      }
    }
    bytes = sum;
  } else if (meta.keyLength != null && meta.valueLength != null) {
    // 分支 4：GQA（普通注意力，逐层求和）
    branch = "gqa";
    attentionLayers = layersKv;
    let sum = 0;
    for (let l = 0; l < layersKv; l++) {
      const nKvL = headCountKvAt(meta, l);
      const vW = opts.flashAttn ? nKvL * valLen : maxKvValueWidth(meta, valLen);
      sum += totalCells * (nKvL * keyLen * bpeK + vW * bpeV);
    }
    bytes = sum;
  } else {
    // 分支 5：legacy 兜底
    branch = "legacy";
    attentionLayers = layersKv;
    const hd = meta.embeddingLength != null && meta.headCount != null ? Math.floor(meta.embeddingLength / meta.headCount) : 128;
    bytes = 2 * nKv * hd * layersKv * totalCells * bpeK;
  }

  return { bytes: Math.ceil(bytes), branch, attentionLayers, layout };
}

// ---------- 4. Compute buffer ----------

/** compute buffer 的安全系数。 */
export const COMPUTE_BUFFER_SAFETY = 1.15;
/**
 * 激活暂存系数（每 n_embd × 每 ubatch token 的 f32 副本数）。实测校准：
 * Spark-4B（embd=2560, ub=512）时 llama.cpp 的常量部分约 40 MiB，
 * 8 × 2560 × 512 × 4 ≈ 41.9 MB，加 1.15 安全系数后 48.2 MB，与实测 40 MiB 同量级
 * （×4 系数只有一半，会系统性低估；×8 略偏高但方向安全）。
 */
export const COMPUTE_ACT_SCRATCH_MULT = 8;

export type ComputeBufferOpts = {
  ubatch: number | null;
  parallel: number;
  tensorSplit: boolean;
  vocabSize?: number | null;
};

/**
 * 与上下文无关的那部分 compute buffer（f32 logits 输出 + 激活暂存）。
 * llama.cpp 的 output buffer 按**需要输出 logits 的 token 数**分配（聊天场景
 * = 每个 slot 一个，`vocab × parallel × 4`），不是按 ubatch。
 */
export function estimateComputeBufferBytes(meta: GgufModelMeta, opts: ComputeBufferOpts): number {
  const ub = opts.ubatch ?? 512;
  const par = Math.max(1, Math.floor(opts.parallel) || 1);
  const vocab = opts.vocabSize ?? meta.vocabSize ?? 0;
  const embd = meta.embeddingLength ?? 0;
  if (embd <= 0) return 0; // 维度不够，交给上层用平坦兜底（vocab 缺失时 outputBuffer 记 0 继续算）
  const outBuffer = vocab * par * 4; // f32 logits：每个 slot 一个输出 token，不乘 ubatch
  const actScratch = COMPUTE_ACT_SCRATCH_MULT * embd * ub * 4;
  const raw = opts.tensorSplit ? 2 * (outBuffer + actScratch) : outBuffer + actScratch;
  return Math.ceil(raw * COMPUTE_BUFFER_SAFETY);
}

/** KQ mask 是 [n_kv, n_ubatch] 的 f16，安全系数 1.5。 */
export const CTX_COMPUTE_F16_MASK_SAFETY = 1.5;
/** 多卡按层切分时 KQ mask 复制份数（台阶，不是斜坡）。 */
export const CTX_COMPUTE_SPLIT_MULT = 4;
/** 量化 KV 反量化暂存：每 n_embd 字节（非 MLA）。 */
export const CTX_COMPUTE_BYTES_PER_EMBD = 2.25;
/** 量化 KV 反量化暂存：每 n_embd 字节（MLA，用 kvLoraRank 量级）。 */
export const CTX_COMPUTE_BYTES_PER_EMBD_MLA = 1.25;
/**
 * flash attention **关闭**时每 token 的注意力分数矩阵系数（实测校准）：
 * 分数矩阵 [headCount, ubatch, n_kv] 要完整物化，随上下文线性增长。
 * llama.cpp 实测：16 heads × ubatch 512 时约 80 字节/token/上下文，即
 * heads × ubatch × 5（理论下界是 ×4 = f32 分数矩阵，多出的 25% 是
 * softmax 中间量与对齐）。关掉 FA 与开着 FA 差约一个数量级。
 */
export const CTX_COMPUTE_NO_FA_MULT = 5;
/**
 * flash attention **开启**时 KQ mask 的每 ubatch-token 字节数（实测校准）：
 * FA 只物化一个 KQ mask。实测约 6.4 字节/token/ubatch，取 7 = 2 × 3.5 保守。
 */
export const CTX_COMPUTE_FA_MASK_MULT = 3.5;

export type CtxComputeOpts = {
  ctxTokens: number;
  ubatch: number | null;
  cacheTypeKv: string | null;
  layerSplit: boolean;
  /** flash attention 开关：关掉时注意力分数矩阵要完整物化，是数量级差异 */
  flashAttn: boolean;
};

/** 随上下文线性增长的那部分 compute buffer。 */
export function computeBufferCtxBytes(meta: GgufModelMeta, opts: CtxComputeOpts): number {
  const ub = opts.ubatch ?? 512;
  const maskRate = ub * 2 * CTX_COMPUTE_F16_MASK_SAFETY; // KQ mask 是 [n_kv, n_ubatch] 的 f16
  const splitExtra = opts.layerSplit ? (CTX_COMPUTE_SPLIT_MULT - 1) * maskRate : 0;
  let perTok: number;
  if (!opts.flashAttn) {
    // FA 关闭：注意力分数矩阵 [headCount, ubatch, n_kv] 要完整物化
    perTok = (meta.headCount ?? 8) * ub * CTX_COMPUTE_NO_FA_MULT;
  } else {
    perTok = ub * 2 * CTX_COMPUTE_FA_MASK_MULT; // FA 开启：只需要一个 KQ mask
  }
  if (kvBytesPerElem(opts.cacheTypeKv) < 2.0) {
    // 量化 KV：反量化暂存随 n_embd 线性增长（FA 开关下都要）
    const rate = meta.kvLoraRank != null ? CTX_COMPUTE_BYTES_PER_EMBD_MLA : CTX_COMPUTE_BYTES_PER_EMBD;
    perTok += rate * (meta.embeddingLength ?? 0) * (ub / 512);
  }
  return Math.ceil((perTok + splitExtra) * Math.max(0, opts.ctxTokens));
}

// ---------- 5. 显存预算 ----------

/** 拟合预算占显存的比例。留 3% 给显存碎片、多卡 CUDA context、MoE 路由这些估不准的部分。 */
export const VRAM_FIT_FRACTION = 0.97;
/** 每张 GPU 的 CUDA context + cuBLAS workspace 常驻开销。 */
export const CUDA_CONTEXT_RESERVE_BYTES = 320 * 1024 * 1024;
/** 多模态投影器运行时占用相对文件大小的倍率。 */
export const MMPROJ_VRAM_SAFETY = 1.4;
/** 按层切分到多卡时，每多一张卡的固定额外开销。 */
export const PIPELINE_PER_DEVICE_OVERHEAD_BYTES = 1024 * 1024 * 1024;
/** 自动拟合时上下文的下限；低于这个值不如不跑。 */
export const MIN_FIT_CTX = 4096;

/**
 * 一张卡上真正可用于本次加载的字节数。
 * total 已知时按「绝对预留」算（free 减掉总量的 (1-fraction)）——已经被别的进程占用时这样才正确；
 * total 未知（MIG / vGPU / 核显报 0）时退回按 free 打折。
 */
export function usableDeviceBytes(freeBytes: number, totalBytes: number, fraction?: number): number {
  const f = fraction ?? VRAM_FIT_FRACTION;
  if (totalBytes > 0) return Math.max(0, Math.floor(freeBytes - (1 - f) * totalBytes));
  return Math.max(0, Math.floor(freeBytes * f));
}

/** 权重之外的常驻开销：CUDA context（有 GPU 时）+ mmproj 的运行时余量。 */
export type FootprintOpts = {
  weightsBytes: number;
  mmprojBytes?: number | null;
  hasGpu: boolean;
  deviceCount?: number | null; // 按层切分用了几张卡，默认 1
  computeBufferBytes: number; // estimateComputeBufferBytes 的结果
};

export function modelFootprintBytes(opts: FootprintOpts): number {
  const mm = opts.mmprojBytes ?? 0;
  const devices = Math.max(1, Math.floor(opts.deviceCount ?? 1));
  const base = opts.weightsBytes + mm + opts.computeBufferBytes;
  const soft = (opts.hasGpu ? CUDA_CONTEXT_RESERVE_BYTES : 0) + mm * (MMPROJ_VRAM_SAFETY - 1);
  const extra = (devices - 1) * PIPELINE_PER_DEVICE_OVERHEAD_BYTES;
  return Math.ceil(base + soft + extra);
}

// ---------- 6. 上下文拟合 ----------

/**
 * K/V 两个 cache 类型里取每元素字节数更大的那个（用于 ctx 线性 compute buffer 的定价）。
 * null / 空串按 f16（2.0）保守定价；同价时优先返回非 null / 非空串的名字，两边都是
 * 具体名字时返回第一个（k），两边都是 null 时返回 "f16"（下游需要一个可用的类型名，
 * 而 null 的定价本来就是按 f16 走的）。
 */
export function heavierCacheType(k: string | null, v: string | null): string {
  const wk = kvBytesPerElem(k);
  const wv = kvBytesPerElem(v);
  if (wv > wk) return v ?? "f16";
  if (wk > wv) return k ?? "f16";
  const hasK = k !== null && k !== "";
  const hasV = v !== null && v !== "";
  if (hasK) return k;
  if (hasV) return v;
  return "f16";
}

export type FitContextInput = {
  meta: GgufModelMeta;
  /** 可用预算（已经用 usableDeviceBytes 扣过 headroom，别再打折） */
  budgetBytes: number;
  /** modelFootprintBytes 的结果 */
  footprintBytes: number;
  requestedCtx: number;
  minCtx?: number; // 默认 MIN_FIT_CTX
  parallel: number;
  kvUnified: boolean;
  cacheTypeK: string | null;
  cacheTypeV: string | null;
  flashAttn: boolean;
  ubatch: number | null;
  layerSplit: boolean; // 是否跨卡按层切分（影响 ctx 线性 compute buffer）
};

export type FitContextReason =
  | "requested-fits" // 请求值本来就装得下
  | "no-metadata" // 元数据不足，估不了，原样返回请求值
  | "weights-exceed-budget" // 光权重就超预算，降 ctx 没用
  | "reduced" // 二分降到了一个装得下的值
  | "floor" // 降到下限仍然装不下
  ;

export type FitContextResult = {
  ctxTokens: number;
  fits: boolean;
  reason: FitContextReason;
  /** 在最终 ctxTokens 下的各项估算，供 UI 展示与日志对照 */
  kvBytes: number;
  ctxComputeBytes: number;
  totalBytes: number;
};

export function fitContextToBudget(input: FitContextInput): FitContextResult {
  const requestedCtx = input.requestedCtx;
  const minCtx = Math.min(input.minCtx ?? MIN_FIT_CTX, requestedCtx);

  const kvOf = (c: number): number => {
    const est = estimateKvCacheBytes(input.meta, {
      ctxTokens: c,
      parallel: input.parallel,
      kvUnified: input.kvUnified,
      cacheTypeK: input.cacheTypeK,
      cacheTypeV: input.cacheTypeV,
      flashAttn: input.flashAttn,
      ubatch: input.ubatch,
    });
    return est === null ? 0 : est.bytes;
  };
  const ctxComputeOf = (c: number): number =>
    computeBufferCtxBytes(input.meta, {
      ctxTokens: c,
      ubatch: input.ubatch,
      cacheTypeKv: heavierCacheType(input.cacheTypeK, input.cacheTypeV),
      layerSplit: input.layerSplit,
      flashAttn: input.flashAttn,
    });
  const totalOf = (c: number): number => input.footprintBytes + kvOf(c) + ctxComputeOf(c);

  if (!canEstimateKv(input.meta) || requestedCtx <= 0) {
    return { ctxTokens: requestedCtx, fits: false, reason: "no-metadata", kvBytes: 0, ctxComputeBytes: 0, totalBytes: 0 };
  }

  const kvReq = kvOf(requestedCtx);
  const ctxReq = ctxComputeOf(requestedCtx);
  const totalReq = input.footprintBytes + kvReq + ctxReq;

  if (totalReq <= input.budgetBytes) {
    return { ctxTokens: requestedCtx, fits: true, reason: "requested-fits", kvBytes: kvReq, ctxComputeBytes: ctxReq, totalBytes: totalReq };
  }
  if (input.footprintBytes >= input.budgetBytes) {
    return { ctxTokens: requestedCtx, fits: false, reason: "weights-exceed-budget", kvBytes: kvReq, ctxComputeBytes: ctxReq, totalBytes: totalReq };
  }

  // 二分：total 对 c 单调不减，找最大的能装下的 c
  let lo = minCtx;
  let hi = requestedCtx;
  let best = minCtx;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (totalOf(mid) <= input.budgetBytes) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  best = Math.floor(best / KV_CELL_ALIGN) * KV_CELL_ALIGN;
  best = Math.max(minCtx, Math.min(best, requestedCtx));

  const kv = kvOf(best);
  const ctxC = ctxComputeOf(best);
  const total = input.footprintBytes + kv + ctxC;
  return total <= input.budgetBytes
    ? { ctxTokens: best, fits: true, reason: "reduced", kvBytes: kv, ctxComputeBytes: ctxC, totalBytes: total }
    : { ctxTokens: best, fits: false, reason: "floor", kvBytes: kv, ctxComputeBytes: ctxC, totalBytes: total };
}

// ---------- 7. 启动计划（组装层） ----------

/** 统一内存（Apple Silicon）预算占比：内存即显存，要给系统与其它应用留出四分之一。 */
export const UNIFIED_MEMORY_BUDGET_RATIO = 0.75;
/** 纯 CPU 预算占比：只认当前空闲内存，权重之外还有页缓存，再留 40%。 */
export const SYSTEM_MEMORY_BUDGET_RATIO = 0.6;

export type PlannerHardware = {
  hasGpu: boolean;
  /** 独显当前空闲显存；无独显或探测不到给 null */
  vramFreeBytes: number | null;
  /** 独显总显存；未知（MIG/vGPU/核显）给 null 或 0 */
  vramTotalBytes: number | null;
  systemFreeBytes: number;
  systemTotalBytes: number;
  /** Apple Silicon 这类统一内存：内存即显存 */
  unifiedMemory: boolean;
  cpuThreads: number;
};

/** 用户在「运行模型」页填的值。null / undefined 一律表示「自动」。 */
export type PlannerOverrides = {
  ctxTokens?: number | null;
  parallel?: number | null;
  batch?: number | null;
  ubatch?: number | null;
  cacheTypeK?: string | null;
  cacheTypeV?: string | null;
  flashAttn?: boolean | null;
};

export type LaunchPlanInput = {
  meta: GgufModelMeta;
  weightsBytes: number;
  mmprojBytes?: number | null;
  hardware: PlannerHardware;
  overrides?: PlannerOverrides;
  /** 引擎是否支持 --kv-unified；不支持时 parallel > 1 会把总窗口按 slot 均分 */
  supportsKvUnified?: boolean;
  /** 自动拟合时上下文的下限（token）；缺省 MIN_FIT_CTX（4096）。用户显式 ctx 不受它约束。 */
  minCtx?: number;
};

/** 可稳定翻译的原因码，UI 与日志都用它 */
export type PlanReasonCode =
  | "ctx.user" // 用户显式指定了上下文，不自动调整
  | "ctx.native" // 用了模型训练窗口
  | "ctx.reduced" // 按显存把窗口降下来了
  | "ctx.floor" // 降到下限仍装不下
  | "ctx.no-metadata" // 元数据不足，估不了
  | "budget.vram" // 预算来自独显空闲显存
  | "budget.unified" // 预算来自统一内存
  | "budget.system" // 预算来自系统内存（纯 CPU）
  | "budget.overflow-to-system" // 显存装不下，预算溢出到系统内存（二级拟合）
  | "fa.forced-on" // 默认开启 flash attention
  | "fa.budget-conservative" // 预算按 FA 关闭计价（见下）
  | "kv.unified" // 加了 --kv-unified
  | "kv.split-per-slot" // 引擎不支持 kv-unified，总窗口会被 slot 均分
  | "batch.raised" // batch 被抬到 max(2, parallel)
  | "gpu.partial-offload" // 装不下，给出了建议的 GPU 层数
  | "gpu.none"; // 没有可用 GPU

export type PlanReason = { code: PlanReasonCode; detail?: Record<string, string | number | boolean> };

export type LaunchPlan = {
  ctxTokens: number; // llama.cpp 的 --ctx-size（KV 总量）
  ctxPerSlot: number; // 单个请求真正能用的窗口 = kvUnified ? ctxTokens : floor(ctxTokens / parallel)
  parallel: number;
  batch: number;
  ubatch: number;
  cacheTypeK: string;
  cacheTypeV: string;
  flashAttn: boolean;
  kvUnified: boolean;
  /** null 表示不发 --n-gpu-layers（交给引擎自己决定）；数字表示建议卸载的层数 */
  gpuLayers: number | null;
  fits: boolean;
  estimates: {
    budgetBytes: number;
    weightsBytes: number;
    kvBytes: number;
    computeBufferBytes: number;
    ctxComputeBytes: number;
    totalBytes: number;
    /** 这次拟合实际用到的溢出到系统内存的额度（未用到为 0） */
    overflowBytes: number;
  };
  reasons: PlanReason[];
};

/**
 * 本次启动的内存/显存预算来自哪：独显空闲显存 / 统一内存 / 系统内存（纯 CPU）。
 * 探测不到空闲显存（null）的独显不走 vram 分支——退回内存口径，避免把预算算成 0。
 */
export function resolveBudgetBytes(hw: PlannerHardware): {
  budgetBytes: number;
  basis: "vram" | "unified" | "system";
  /** 显存装不下时可以继续往里溢的系统内存额度；basis 不是 "vram" 时为 0 */
  overflowBytes: number;
} {
  if (hw.hasGpu && hw.vramFreeBytes != null && hw.vramFreeBytes > 0 && !hw.unifiedMemory) {
    return {
      budgetBytes: usableDeviceBytes(hw.vramFreeBytes, hw.vramTotalBytes ?? 0),
      basis: "vram",
      overflowBytes: Math.floor(hw.systemFreeBytes * SYSTEM_MEMORY_BUDGET_RATIO),
    };
  }
  if (hw.unifiedMemory) {
    return { budgetBytes: Math.floor(hw.systemTotalBytes * UNIFIED_MEMORY_BUDGET_RATIO), basis: "unified", overflowBytes: 0 };
  }
  return { budgetBytes: Math.floor(hw.systemFreeBytes * SYSTEM_MEMORY_BUDGET_RATIO), basis: "system", overflowBytes: 0 };
}

function clampInt(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(value)));
}

/**
 * 把「硬件 + 元数据 + 用户填的参数」组装成一个可翻译的 llama.cpp 启动计划。
 * 决策顺序（reasons 按此顺序产生，不要排序）：
 * 并发/批大小 → KV 类型/FA → kv-unified → 预算 → 上下文拟合 → 最终估算 → GPU 层数。
 */
export function planLlamaLaunch(input: LaunchPlanInput): LaunchPlan {
  const o = input.overrides ?? {};
  const meta = input.meta;
  const reasons: PlanReason[] = [];

  // —— 并发与批大小 ——
  const parallel = Math.max(1, Math.floor(o.parallel ?? 1));
  const ubatch = Math.max(1, Math.floor(o.ubatch ?? 512));
  const batchRaw = Math.max(1, Math.floor(o.batch ?? 2048));
  const batch = Math.max(batchRaw, Math.max(2, parallel));
  if (batch !== batchRaw) reasons.push({ code: "batch.raised", detail: { from: batchRaw, to: batch } });

  // —— KV 类型与 flash attention ——
  const cacheTypeK = o.cacheTypeK ?? "f16";
  const cacheTypeV = o.cacheTypeV ?? "f16";
  const flashAttn = o.flashAttn ?? true;
  if (o.flashAttn == null) reasons.push({ code: "fa.forced-on" });

  // 预算按「用户实际会开没开 FA」计价（T4d）：llama.ts 会把「设置值 + 上次实测」
  // 折算成一个布尔传进来（unknown 时保守按关）。明确知道开着就按开着算（量化 V 不被
  // 抬到 f16、ctx 线性 compute buffer 走 FA 那条）；不知道才保守按关，宁可窗口小也不 OOM。
  const budgetFlashAttn = o.flashAttn ?? false;
  // 量化 V 被抬到 f16 计价时出保守 reason。两种触发：
  //   1. 未显式指定（默认开，flashAttn=true）但 llama.ts 折成「未知」→ 保守按关
  //      （budgetFlashAttn=false）—— 用户以为开着，实际按关算，要提醒
  //   2. 用户显式关掉 FA（o.flashAttn=false → flashAttn=false）—— llama.cpp 不接受
  //      量化 V，退回 f16，窗口会比以为的小
  //   用户未指定 + f16 V：V 本来就是 f16，抬价不影响，不出 reason。
  const conservative =
    (!budgetFlashAttn && kvBytesPerElem(cacheTypeV) < 2.0) &&
    (flashAttn !== budgetFlashAttn || o.flashAttn === false);
  if (conservative) {
    reasons.push({ code: "fa.budget-conservative" });
  }

  const kvUnified = parallel > 1 && (input.supportsKvUnified ?? true);
  if (parallel > 1 && kvUnified) reasons.push({ code: "kv.unified" });
  if (parallel > 1 && !kvUnified) reasons.push({ code: "kv.split-per-slot", detail: { parallel } });

  // —— 预算 ——
  const { budgetBytes, basis, overflowBytes } = resolveBudgetBytes(input.hardware);
  const budgetCode: PlanReasonCode =
    basis === "vram" ? "budget.vram" : basis === "unified" ? "budget.unified" : "budget.system";
  reasons.push({ code: budgetCode, detail: { budgetBytes } });
  if (!input.hardware.hasGpu) reasons.push({ code: "gpu.none" });

  // —— 常量 compute buffer 与 footprint ——
  const computeBufferBytes = estimateComputeBufferBytes(meta, { ubatch, parallel, tensorSplit: false });
  const footprintBytes = modelFootprintBytes({
    weightsBytes: input.weightsBytes,
    mmprojBytes: input.mmprojBytes,
    hasGpu: input.hardware.hasGpu,
    deviceCount: 1,
    computeBufferBytes,
  });

  // —— 上下文 ——
  const requestedCtx = o.ctxTokens ?? meta.contextLength ?? 8192;
  const userExplicit = o.ctxTokens != null && o.ctxTokens > 0;

  const minCtx = input.minCtx ?? MIN_FIT_CTX;
  const fit = fitContextToBudget({
    meta,
    budgetBytes,
    footprintBytes,
    requestedCtx,
    minCtx,
    parallel,
    kvUnified,
    cacheTypeK,
    cacheTypeV,
    flashAttn: budgetFlashAttn,
    ubatch,
    layerSplit: false,
  });

  // —— 二级预算：显存装不下 → 溢出到系统内存，用 totalBudget 重新拟合 ——
  // 统一内存 / 纯 CPU 的预算本来就是内存，没有第二层，overflowBytes 为 0，不会进来。
  // 用户显式指定 ctx 时绝不自动缩小（哪怕溢出也救不回那个请求值）。
  let effectiveBudget = budgetBytes;
  let usedOverflow = 0;
  let finalFit = fit;
  if (basis === "vram" && !fit.fits && !userExplicit && overflowBytes > 0) {
    const totalBudget = budgetBytes + overflowBytes;
    const refit = fitContextToBudget({
      meta,
      budgetBytes: totalBudget,
      footprintBytes,
      requestedCtx,
      minCtx,
      parallel,
      kvUnified,
      cacheTypeK,
      cacheTypeV,
      flashAttn: budgetFlashAttn,
      ubatch,
      layerSplit: false,
    });
    // 只有溢出拟合真的救活了（fits）才采用它：否则保留 GPU 预算那次的结果（floor）
    if (refit.fits) {
      finalFit = refit;
      effectiveBudget = totalBudget;
      // 这次拟合比纯 GPU 预算多用了多少 → 实际落到系统内存的额度（至少 1 字节，上限 overflowBytes）
      usedOverflow = Math.min(overflowBytes, Math.max(1, refit.totalBytes - budgetBytes));
      reasons.push({ code: "budget.overflow-to-system", detail: { vram: budgetBytes, system: overflowBytes } });
    }
  }

  let ctxTokens: number;
  if (userExplicit) {
    ctxTokens = requestedCtx; // 用户说了算，绝不自动缩小（fit 按 GPU 预算算的那次）
    reasons.push({ code: "ctx.user", detail: { ctxTokens, fits: fit.fits } });
  } else {
    ctxTokens = finalFit.ctxTokens;
    const code: PlanReasonCode =
      finalFit.reason === "requested-fits"
        ? "ctx.native"
        : finalFit.reason === "reduced"
          ? "ctx.reduced"
          : finalFit.reason === "floor"
            ? "ctx.floor"
            : finalFit.reason === "no-metadata"
              ? "ctx.no-metadata"
              : "ctx.floor"; // weights-exceed-budget：降 ctx 没用，与 floor 同一处置（给出建议）
    reasons.push({ code, detail: { requested: requestedCtx, ctxTokens } });
  }

  const ctxPerSlot = kvUnified ? ctxTokens : Math.max(1, Math.floor(ctxTokens / parallel));

  // —— 最终估算（按真正要用的 ctxTokens 重算一次）——
  const kvBytes =
    estimateKvCacheBytes(meta, {
      ctxTokens,
      parallel,
      kvUnified,
      cacheTypeK,
      cacheTypeV,
      flashAttn: budgetFlashAttn,
      ubatch,
    })?.bytes ?? 0;
  const ctxComputeBytes = computeBufferCtxBytes(meta, {
    ctxTokens,
    ubatch,
    cacheTypeKv: heavierCacheType(cacheTypeK, cacheTypeV),
    layerSplit: false,
    // 与 KV 估算同一套假设：预算恒按 FA 关闭计价
    flashAttn: budgetFlashAttn,
  });
  const totalBytes = footprintBytes + kvBytes + ctxComputeBytes;
  const planFits = totalBytes <= effectiveBudget;

  // —— GPU 层数（仍按 GPU 预算 budgetBytes，不用 totalBudget）——
  let gpuLayers: number | null;
  if (!input.hardware.hasGpu) {
    gpuLayers = 0;
  } else if (planFits && basis !== "vram") {
    gpuLayers = null; // 不发参数，交给引擎全卸载（纯内存场景）
  } else if (planFits && basis === "vram" && totalBytes <= budgetBytes) {
    gpuLayers = null; // 整模都能装进显存，全卸载
  } else if (meta.blockCount != null && meta.blockCount > 0) {
    // 部分卸载：每往显存放一层，既要放它的权重，也要放它那一份 KV（保守近似，按层均摊）
    const perLayerWeights = input.weightsBytes / meta.blockCount;
    const estForLayout = estimateKvCacheBytes(meta, {
      ctxTokens,
      parallel,
      kvUnified,
      cacheTypeK,
      cacheTypeV,
      flashAttn: budgetFlashAttn,
      ubatch,
    });
    const kvBytesForLayout = estForLayout?.bytes ?? 0;
    const attnLayers = Math.max(1, estForLayout?.attentionLayers ?? 1);
    const perLayerKv = kvBytesForLayout > 0 ? kvBytesForLayout / attnLayers : 0;
    const nonWeightFixed = footprintBytes - input.weightsBytes; // CUDA context / mmproj 余量 / 常量 compute buffer
    const room = budgetBytes - nonWeightFixed - ctxComputeBytes;
    gpuLayers = clampInt(room / (perLayerWeights + perLayerKv), 0, meta.blockCount);
    reasons.push({ code: "gpu.partial-offload", detail: { gpuLayers, blockCount: meta.blockCount } });
  } else {
    gpuLayers = null;
  }

  return {
    ctxTokens,
    ctxPerSlot,
    parallel,
    batch,
    ubatch,
    cacheTypeK,
    cacheTypeV,
    flashAttn,
    kvUnified,
    gpuLayers,
    fits: planFits,
    estimates: {
      budgetBytes,
      weightsBytes: input.weightsBytes,
      kvBytes,
      computeBufferBytes,
      ctxComputeBytes,
      totalBytes,
      overflowBytes: usedOverflow,
    },
    reasons,
  };
}
