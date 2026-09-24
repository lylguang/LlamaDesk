/**
 * 本地 AI 超分引擎（放大糊图 / 老照片）。
 *
 * 与抠图（bg-remove.ts）同一套路线：**超分模型在本机跑，图片不出进程**，运行时
 * 也是那份 Emscripten 编译的 ONNX Runtime 的 WASM 后端（主进程内）。Upscayl 的
 * 价值全在"完全本地、不上传"，所以这里不碰任何云端厂商 —— 缺的只是权重文件，
 * 而权重就在小应用里下载（多源 + 断点续传，与抠图同一个 downloader 内核）。
 *
 * 模型是 Real-ESRGAN 家族（腾讯 ARC 出品，Apache-2.0，Upscayl 也是用它）：
 *   - `realesrgan-x4plus`：通用 4×，最适合"老照片 / 糊照片"，代价是慢 + 权重大；
 *   - `realesrgan-x4plus-anime`：动漫 / 插画 4×，块数少、快得多；
 *   - `realesr-animevideov3`：轻量 4×，最快，动漫/插画够用（照片上会偏"插画感"）。
 *
 * WASM 单线程的算力有限，超大图直接整图喂会撑爆内存或慢到不可用，所以推理走
 * **切片**：把图切成一排 `tile` 见方的块、带重叠跑模型，再按序拼接 —— 与
 * RealESRGAN 的 `--tile` 参数同一套做法。切片与拼接都是纯函数，单独测。
 */

import { existsSync, mkdirSync } from "fs";
import path from "path";
import sharp from "sharp";
import { getDataDir } from "./paths";
import { safeJoin } from "./path-safety";
import { logEvent } from "./app-log";
import { downloadHttpFile } from "./modelscope";
import { partialBytesFor, removePartialFiles } from "./downloader";

// ---------------------------------------------------------------------------
// 模型清单
// ---------------------------------------------------------------------------

export type UpscaleModelTier = "quality" | "speed" | "fast";

export interface UpscaleModelSpec {
  id: string;
  /** 权重文件名，同时也是落盘名。 */
  file: string;
  /** 线上字节数：用来显示"要下多少"、判断本地那份是否完整。 */
  bytes: number;
  /** 放大倍数（当前均为 4×；导出图的输入输出都是这个整数倍关系）。 */
  scale: number;
  tier: UpscaleModelTier;
  /** 模型固定输入边长下界；喂小于它的尺寸表现不稳，建议先放大到至少 tile。 */
  minInput: number;
  license: string;
}

// 每个模型的下载源（多源轮换，downloadHttpFile 换源时保留已下分片断点续传）。
// Real-ESRGAN 官方只发 .pth，社区把 ONNX 导出发在不同的仓库里 —— 这里主源指向
// 本次核实过可直达的 GitHub raw（文件已逐一验证存在且大小一致），后面接 hf-mirror 兜底。
const HF_MIRROR = "https://hf-mirror.com";

/** id → 候选源列表（最多试到有一个成功；顺序即优先级）。 */
function sourcesFor(spec: UpscaleModelSpec): string[] {
  const RAW = "https://raw.githubusercontent.com";
  const base =
    spec.id === "realesr-animevideov3"
      ? `${RAW}/ntsc-rs-fan/RealESRGAN-AnimeVideo-v3-x4-ONNX/main/RealESR-AnimeVideo-v3_x4.onnx`
      : spec.id === "realesrgan-x4plus-anime"
        ? `${RAW}/muhammad-ahmed-ghani/RealESRGAN_ONNX/main/pretrained_models/RealESRGAN_ANIME_6B_512x512.onnx`
        : `${RAW}/kongxa/RealESRGAN_x4plus/main/RealESRGAN_x4plus.onnx`;
  return [base, `${HF_MIRROR}/${spec.id}/resolve/main/${spec.file}`];
}

export const UPSCALE_MODELS: UpscaleModelSpec[] = [
  {
    id: "realesr-animevideov3",
    file: "realesr-animevideov3.onnx",
    bytes: 2_495_473,
    scale: 4,
    tier: "fast",
    minInput: 64,
    license: "Apache-2.0",
  },
  {
    id: "realesrgan-x4plus-anime",
    file: "realesrgan-x4plus-anime.onnx",
    bytes: 8_970_877,
    scale: 4,
    tier: "speed",
    minInput: 64,
    license: "Apache-2.0",
  },
  {
    id: "realesrgan-x4plus",
    file: "realesrgan-x4plus.onnx",
    bytes: 67_051_642,
    scale: 4,
    tier: "quality",
    minInput: 64,
    license: "Apache-2.0",
  },
];

// 默认走"速度"档的 anime 模型而不是最重的通用模型：WASM 单线程算力有限，
// 第一次用就给 x4plus 会让用户等上几分钟、并且 8.6MB vs 64MB 的下载差别也很大。
// 用户按需在页面里切换到 x4plus 抠通用照片 / 老照片。
export const DEFAULT_UPSCALE_MODEL = "realesrgan-x4plus-anime";

export function upscaleModelSpec(id: string): UpscaleModelSpec | undefined {
  return UPSCALE_MODELS.find((m) => m.id === id);
}

// ---------------------------------------------------------------------------
// 路径与状态
// ---------------------------------------------------------------------------

export function upscaleEngineDir(): string {
  return getDataDir("engines", "upscale");
}

export function upscaleModelDir(): string {
  return path.join(upscaleEngineDir(), "models");
}

/** 权重落盘路径；id 来自 RPC，越界一律返回 null 交给调用方当参数错误处理。 */
export function upscaleModelPath(id: string): string | null {
  const spec = upscaleModelSpec(id);
  if (!spec) return null;
  return safeJoin(upscaleModelDir(), spec.file);
}

export interface UpscaleModelStatus {
  id: string;
  bytes: number;
  scale: number;
  tier: UpscaleModelTier;
  license: string;
  ready: boolean;
  /** 真实已下载字节数（未下载为 0）；进度条与"就绪"都看它，**不看文件长度**。 */
  localBytes: number;
}

/** 真实已下载字节数：与抠图同口径，见 bg-remove.ts 的 downloadedBytesOf 注释。 */
function downloadedBytesOf(dest: string, total: number): number {
  try {
    return Math.min(total, partialBytesFor(dest, total));
  } catch {
    return 0;
  }
}

function isDownloadInFlight(id: string): boolean {
  const dest = upscaleModelPath(id);
  return Boolean(dest && existsSync(`${dest}.download.json`));
}

export function listUpscaleModels(): UpscaleModelStatus[] {
  return UPSCALE_MODELS.map((spec) => {
    const dest = upscaleModelPath(spec.id);
    const localBytes = dest ? downloadedBytesOf(dest, spec.bytes) : 0;
    return {
      id: spec.id,
      bytes: spec.bytes,
      scale: spec.scale,
      tier: spec.tier,
      license: spec.license,
      ready: localBytes >= spec.bytes,
      localBytes,
    };
  });
}

export function isUpscaleModelReady(id: string): boolean {
  const spec = upscaleModelSpec(id);
  const dest = upscaleModelPath(id);
  if (!spec || !dest) return false;
  return downloadedBytesOf(dest, spec.bytes) >= spec.bytes;
}

/** 任意一个可用的模型 id（优先默认模型）。没下过任何模型时返回 null。 */
export function anyReadyUpscaleModel(): string | null {
  if (isUpscaleModelReady(DEFAULT_UPSCALE_MODEL)) return DEFAULT_UPSCALE_MODEL;
  const ready = UPSCALE_MODELS.find((m) => isUpscaleModelReady(m.id));
  return ready ? ready.id : null;
}

export interface UpscaleDownloadProgress {
  model: string;
  loaded: number;
  total: number;
  percent: number;
}

/**
 * 下载权重。多源 + 断点续传 + 进度都在 downloader 内核里，这里只做源轮换。
 */
export async function downloadUpscaleModel(
  id: string,
  options: {
    onProgress?: (p: UpscaleDownloadProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<{ ok: true; path: string; size: number } | { ok: false; error: string }> {
  const spec = upscaleModelSpec(id);
  const dest = upscaleModelPath(id);
  if (!spec || !dest) {
    return { ok: false, error: `unknown model: ${id}` };
  }
  if (isUpscaleModelReady(id)) {
    return { ok: true, path: dest, size: spec.bytes };
  }
  mkdirSync(path.dirname(dest), { recursive: true });

  const sources = sourcesFor(spec);
  let lastError = "download failed";
  for (const url of sources) {
    try {
      const res = await downloadHttpFile(
        url,
        dest,
        (progress) => {
          const total = progress.total ?? spec.bytes;
          const percent =
            progress.percent ??
            (total > 0 ? Math.min(100, Math.round((progress.received / total) * 100)) : 0);
          options.onProgress?.({
            model: id,
            loaded: progress.received,
            total,
            percent,
          });
        },
        options.signal,
      );
      logEvent({
        level: "info",
        source: "image",
        event: "upscale.model.downloaded",
        message: `超分模型下载完成：${id}`,
        detail: { model: id, bytes: res.size, from: url },
      });
      return { ok: true, path: res.path, size: res.size };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (options.signal?.aborted) break;
      logEvent({
        level: "warn",
        source: "image",
        event: "upscale.model.source_failed",
        message: `超分模型源失败，尝试下一个：${url}`,
        detail: { model: id, error: lastError },
      });
    }
  }

  logEvent({
    level: "error",
    source: "image",
    event: "upscale.model.download_failed",
    message: `超分模型下载失败：${id}`,
    detail: { model: id, error: lastError },
  });
  return { ok: false, error: lastError };
}

// ---------------------------------------------------------------------------
// ONNX Runtime（WASM）—— 与抠图同一份，见 bg-remove.ts 的 loadOrt 注释。
// ---------------------------------------------------------------------------

type OrtModule = typeof import("onnxruntime-web");

let ortPromise: Promise<OrtModule> | null = null;
let sessionCache: { model: string; session: Promise<import("onnxruntime-web").InferenceSession> } | null =
  null;

function runtimeAssetDirs(): string[] {
  return [
    import.meta.dir,
    path.join(import.meta.dir, "..", "..", "node_modules", "onnxruntime-web", "dist"),
    path.join(process.cwd(), "node_modules", "onnxruntime-web", "dist"),
  ];
}

const GLUE_FILE = "ort-wasm-simd-threaded.mjs";
const WASM_FILE = "ort-wasm-simd-threaded.wasm";

function findRuntimeAsset(file: string): string | null {
  for (const dir of runtimeAssetDirs()) {
    const candidate = path.join(dir, file);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function loadOrt(): Promise<OrtModule> {
  if (!ortPromise) {
    ortPromise = (async () => {
      const ort = (await import("onnxruntime-web")) as OrtModule;

      // **必须开多线程**：超分比抠图重得多（512² 一块），单线程实测 ~73s/块，
      // 一张 600×800 要 4 块就是 5 分钟 —— 用户会以为卡死。开线程后实测 4 线程
      // 18.6s/块（~4×），是"能不能用"的差别。Bun 有 SharedArrayBuffer，pthread
      // worker 也能起来（抠图那边"开了会抛错"的注释对本模块不成立，这里实测通过）。
      //
      // 上限 8：机器可能几十核，但推理不该把整机吃满（同机还在跑推理服务器 / 界面）。
      // 起不来就退回单线程，不影响结果。
      try {
        const cores = Number(
          (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator
            ?.hardwareConcurrency ?? 4,
        );
        ort.env.wasm.numThreads = Math.max(1, Math.min(8, Math.floor(cores) - 1 || 1));
      } catch {
        ort.env.wasm.numThreads = 1;
      }

      const glue = findRuntimeAsset(GLUE_FILE);
      const wasm = findRuntimeAsset(WASM_FILE);
      if (!glue || !wasm) {
        throw new Error(
          `缺少 ONNX 运行时文件（${GLUE_FILE} / ${WASM_FILE}）——打包时需随主进程一起复制到 bun/ 下`,
        );
      }
      const { pathToFileURL } = await import("node:url");
      ort.env.wasm.wasmPaths = { mjs: pathToFileURL(glue).href };
      ort.env.wasm.wasmBinary = await Bun.file(wasm).arrayBuffer();
      return ort;
    })().catch((e) => {
      ortPromise = null;
      throw e;
    });
  }
  return ortPromise;
}

async function getSession(modelId: string) {
  if (sessionCache?.model === modelId) return sessionCache.session;
  const dest = upscaleModelPath(modelId);
  if (!dest || !isUpscaleModelReady(modelId)) throw new Error(`模型未就绪：${modelId}`);
  const ort = await loadOrt();
  const previous = sessionCache?.session;
  const session = ort.InferenceSession.create(await Bun.file(dest).arrayBuffer(), {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  sessionCache = { model: modelId, session };
  if (previous) void previous.then((s) => s.release?.()).catch(() => {});
  void session.catch(() => {
    if (sessionCache?.session === session) sessionCache = null;
  });
  return session;
}

// ---------------------------------------------------------------------------
// 切片 / 拼接（纯函数，单独测）
// ---------------------------------------------------------------------------

/**
 * 导出图的长边上限。拼接的加权平均缓冲按**输出分辨率**分配（3 通道 float + 权重），
 * 8192² 就要 ~800MB，所以在解码阶段先把源图缩到这个上限之内（放大后 ≤ 4096）。
 * 只挡异常大的输入：4096 的输出对"救糊图 / 老照片"这个用途来说绰绰有余。
 */
const MAX_OUTPUT_SIDE = 4096;

export interface TileGrid {
  /** 切多少列 / 多少行。 */
  cols: number;
  rows: number;
  /** 每个 tile 的边长（像素，方形的；带重叠后实际切成 tile 大小）。 */
  tile: number;
  /** tile 之间的重叠（像素）。 */
  overlap: number;
}

/**
 * 按目标长边把图切成 `cols × rows` 的方块网格。
 *
 * 规则：单个 tile 边长固定（`tile` 内），超出则增加行列数；保证面积不超过上限
 * （第 N 个 tile 不会让内存比第 1 个更炸）。贪心按行优先扩展 —— 长条形照片
 * 会横向多切，竖条会纵向多切。
 */
export function planTileGrid(
  width: number,
  height: number,
  tile: number,
  overlap: number,
): TileGrid {
  const eff = Math.max(1, tile - overlap);
  const cols = Math.max(1, Math.ceil(width / eff));
  const rows = Math.max(1, Math.ceil(height / eff));
  return { cols, rows, tile, overlap };
}

export interface TileCoord {
  /** 该 tile 在原图里的左上角（像素）。 */
  x: number;
  y: number;
  /** 该 tile 在原图里实际占用的宽高（边缘块会被 clamp 到图边）。 */
  srcW: number;
  srcH: number;
  /** 该 tile 放大后（scale 倍）的宽高。 */
  outW: number;
  outH: number;
  col: number;
  row: number;
}

export function tileCoords(grid: TileGrid, width: number, height: number): TileCoord[] {
  const out: TileCoord[] = [];
  for (let row = 0; row < grid.rows; row += 1) {
    for (let col = 0; col < grid.cols; col += 1) {
      const x = col * (grid.tile - grid.overlap);
      const y = row * (grid.tile - grid.overlap);
      const srcW = Math.min(grid.tile, width - x);
      const srcH = Math.min(grid.tile, height - y);
      out.push({
        x,
        y,
        srcW,
        srcH,
        outW: srcW * 1, // 占位：真实倍数由推理输出尺寸决定，见 stitch
        outH: srcH * 1,
        col,
        row,
      });
    }
  }
  return out;
}

/**
 * 把切片放大后的若干张 RGB 贴回一张大画布（alpha 合成为 0）。
 *
 * 每个 tile 都已经放大到 `srcW×scale` × `srcH×scale`，这里按各自的原图偏移贴到
 * scale 倍的新图上。相邻 tile 带重叠，**重叠区加权平均**（而不是后贴者覆盖）——
 * 否则 512px 的硬拼缝在照片上是非常显眼的横竖条纹。每个输出像素把落在它上面的
 * 各 tile 取值加起来除以次数，接缝处自然过渡。
 *
 * 用 Float32 累加而不是就地写 Uint8：就地写没法做平均，只能二选一，接缝就出来了。
 * 累加缓冲是 3 通道 float + 1 通道权重，所以调用方必须先把源图压到输出不超过
 * MAX_OUTPUT_SIDE（见 upscaleImage 的预缩放），否则这个缓冲会撑爆内存。
 */
export function blendTiles(
  width: number,
  height: number,
  scale: number,
  tiles: { coord: TileCoord; rgb: Buffer | Uint8Array }[],
): { data: Buffer; width: number; height: number } {
  const outW = width * scale;
  const outH = height * scale;
  const pixels = outW * outH;
  const sum = new Float32Array(pixels * 3);
  const weight = new Float32Array(pixels);
  for (const t of tiles) {
    const { coord } = t;
    const oWidth = coord.srcW * scale;
    const oHeight = coord.srcH * scale;
    const rgb = t.rgb;
    const baseX = coord.x * scale;
    const baseY = coord.y * scale;
    for (let yy = 0; yy < oHeight; yy += 1) {
      const srcRow = yy * oWidth;
      const dstRow = ((baseY + yy) * outW + baseX) * 3;
      const wRow = (baseY + yy) * outW + baseX;
      for (let xx = 0; xx < oWidth; xx += 1) {
        const s = (srcRow + xx) * 3;
        const d = dstRow + xx * 3;
        sum[d] = (sum[d] ?? 0) + (rgb[s] ?? 0);
        sum[d + 1] = (sum[d + 1] ?? 0) + (rgb[s + 1] ?? 0);
        sum[d + 2] = (sum[d + 2] ?? 0) + (rgb[s + 2] ?? 0);
        weight[wRow + xx] = (weight[wRow + xx] ?? 0) + 1;
      }
    }
  }
  const out = Buffer.alloc(pixels * 3);
  for (let i = 0; i < pixels; i += 1) {
    const w = weight[i]!;
    if (w <= 0) continue; // 没被任何 tile 覆盖（正常不会发生）→ 留黑
    const inv = 1 / w;
    out[i * 3] = Math.round((sum[i * 3] ?? 0) * inv);
    out[i * 3 + 1] = Math.round((sum[i * 3 + 1] ?? 0) * inv);
    out[i * 3 + 2] = Math.round((sum[i * 3 + 2] ?? 0) * inv);
  }
  return { data: out, width: outW, height: outH };
}

// ---------------------------------------------------------------------------
// 推理
// ---------------------------------------------------------------------------

export interface UpscaleOptions {
  /** 源图绝对路径（调用方负责用 imageRef 解析并校验过）。 */
  imagePath: string;
  /** 模型 id；不传用默认模型，未下载则报错。 */
  model?: string;
  /** 单 tile 边长（像素）**仅对动态尺寸模型有效**；固定尺寸模型按它声明的来。 */
  tile?: number;
  /**
   * 进度回调：每跑完一块报一次（`done`/`total` 是块数）。推理很慢（一块十几秒），
   * 没有这个回调界面只能显示一句"正在放大"，用户分不清是卡死还是在跑。
   */
  onProgress?: (p: { done: number; total: number }) => void;
  /** 只放大、不上采样到更大倍数时的原始尺寸（keepScale = true 表示不额外放大）。 */
  // （当前固定 4×，与大结构一致；留 scale 语义以便将来支持 2×/8× 其它模型。）
}

export interface UpscaleResult {
  /** images/ 下的相对 ref。 */
  outRef: string;
  outUrl: string;
  width: number;
  height: number;
  model: string;
  scale: number;
  inferenceMs: number;
  totalMs: number;
}

/** 模型输入的数据类型（社区里的 Real-ESRGAN ONNX 导出多为 fp16）。 */
type TensorDtype = "float32" | "float16";

const f32Scratch = new Float32Array(1);
const u32Scratch = new Uint32Array(f32Scratch.buffer);

/**
 * float32 → 半精度 float16 的 16 位模式。
 *
 * 为什么需要它：Real-ESRGAN 的社区 ONNX 导出很多是 **fp16** 的（权重减半、体积减半），
 * 这种模型的输入张量类型就是 `tensor(float16)`，喂 `tensor(float32)` 会被运行时直接拒：
 * `Unexpected input data type. Actual: (tensor(float)) , expected: (tensor(float16))`。
 * 我们下到的三个模型里有 fp16 的，所以按模型声明的类型喂，而不是一律 fp32。
 */
export function toHalf(value: number): number {
  f32Scratch[0] = value;
  const x = u32Scratch[0]!;
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  const mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0); // Inf / NaN
  const e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00; // 溢出 → Inf
  if (e <= 0) {
    if (e < -10) return sign; // 下溢 → 0
    // 次正规数：补上隐含的前导 1 再右移
    return sign | (((mant | 0x800000) >>> (1 - e)) >>> 13);
  }
  return sign | (e << 10) | (mant >>> 13);
}

/** 半精度 float16 位模式 → float32（把模型输出换回我们做像素映射用的精度）。 */
export function fromHalf(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >>> 10) & 0x1f;
  const mant = h & 0x03ff;
  if (exp === 0) return sign * 2 ** -14 * (mant / 1024); // 次正规数 / 0
  if (exp === 0x1f) return mant ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + mant / 1024);
}

/**
 * 模型前处理：RGB u8 → NCHW，值域 [0,1]。类型跟着模型走：fp32 给 Float32Array，
 * fp16 给 Uint16Array（ORT 的 float16 张量在 JS 侧就是 16 位整数数组）。
 */
function buildInputTensor(
  rgb: Uint8Array | Buffer,
  tile: number,
  dtype: TensorDtype,
): Float32Array | Uint16Array {
  const pixels = tile * tile;
  if (dtype === "float16") {
    const out = new Uint16Array(pixels * 3);
    for (let i = 0; i < pixels; i += 1) {
      out[i] = toHalf((rgb[i * 3] ?? 0) / 255);
      out[pixels + i] = toHalf((rgb[i * 3 + 1] ?? 0) / 255);
      out[pixels * 2 + i] = toHalf((rgb[i * 3 + 2] ?? 0) / 255);
    }
    return out;
  }
  const out = new Float32Array(pixels * 3);
  for (let i = 0; i < pixels; i += 1) {
    out[i] = (rgb[i * 3] ?? 0) / 255;
    out[pixels + i] = (rgb[i * 3 + 1] ?? 0) / 255;
    out[pixels * 2 + i] = (rgb[i * 3 + 2] ?? 0) / 255;
  }
  return out;
}

/** 模型输出的数据类型：从 session 的元数据里读（fp16 模型输出也是 fp16）。 */
function tensorDtypeOf(
  metadata: readonly { isTensor?: boolean; type?: string }[] | undefined,
): TensorDtype {
  return metadata?.[0]?.type === "float16" ? "float16" : "float32";
}

/**
 * 模型输出统一成 Float32Array。
 *
 * fp16 输出在不同 ORT 版本里有两种表示：较新版本给 **`Float16Array`（值已经是浮点）**，
 * 旧版本给 `Uint16Array`（半精度**位模式**，要自己解）。判错会把 0.5 这种数值再当位模式
 * 解一次，输出整张花掉。所以按类型分派，而不是假定其中一种。
 */
function outputToFloat32(data: ArrayLike<number>): Float32Array {
  if (data instanceof Float32Array) return data;
  const out = new Float32Array(data.length);
  const isFloat16Array =
    typeof (globalThis as { Float16Array?: unknown }).Float16Array !== "undefined" &&
    data instanceof (globalThis as { Float16Array: new () => object }).Float16Array;
  if (isFloat16Array) {
    out.set(data as unknown as ArrayLike<number>);
    return out;
  }
  // Uint16Array：半精度位模式，逐位解回来。
  for (let i = 0; i < data.length; i += 1) out[i] = fromHalf(data[i]!);
  return out;
}

/**
 * 跑一次超分：解码 → 按目标长边切片 → 逐 tile 推理（放大 scale 倍）→ 拼接 → 落盘。
 */
export async function upscaleImage(
  options: UpscaleOptions,
): Promise<{ ok: true; result: UpscaleResult } | { ok: false; error: string }> {
  const started = Date.now();
  const modelId = options.model ?? anyReadyUpscaleModel() ?? DEFAULT_UPSCALE_MODEL;
  const spec = upscaleModelSpec(modelId);
  if (!spec) return { ok: false, error: `unknown model: ${modelId}` };
  if (!isUpscaleModelReady(modelId)) return { ok: false, error: `model-not-ready:${modelId}` };
  if (!existsSync(options.imagePath)) return { ok: false, error: `image not found: ${options.imagePath}` };

  try {
    const meta = await sharp(options.imagePath).rotate().metadata();
    const srcW = meta.width ?? 0;
    const srcH = meta.height ?? 0;
    if (!srcW || !srcH) return { ok: false, error: "无法读取图片尺寸" };

    // 先建会话：模型的输入尺寸与类型都要从 session 元数据读，切片网格得等它。
    const ort = await loadOrt();
    const session = await getSession(modelId);
    const inputName = session.inputNames[0]!;
    const outputName = session.outputNames[0]!;
    // 按模型自己声明的类型喂：社区导出不少是 fp16，喂错类型 ORT 会直接拒
    // （`Unexpected input data type. Actual: (tensor(float)), expected: (tensor(float16))`）。
    const inputDtype = tensorDtypeOf(session.inputMetadata);
    // 模型输入侧边长：很多 Real-ESRGAN 导出是**固定** 512×512（如 x4plus-anime，
    // 导出时 H/W 写死），必须正好喂这个尺寸，喂 128 会直接报 shape 不匹配；
    // 动态尺寸的导出（H/W 是符号名）才按 tile 走。
    const meta0 = session.inputMetadata?.[0] as { shape?: (number | string)[] } | undefined;
    const inShape = meta0?.shape;
    const fixedSide =
      typeof inShape?.[2] === "number" && typeof inShape?.[3] === "number"
        ? Math.min(inShape[2], inShape[3])
        : null;
    const modelSide =
      fixedSide ?? Math.max(16, Math.min(256, Math.floor(options.tile || 128) || 128));

    // 输出上限：blendTiles 的累加缓冲按输出分辨率分配（3 通道 float + 权重），
    // 8192² 就要 ~800MB —— 所以先把源图缩到"放大后不超过 MAX_OUTPUT_SIDE"。
    // 这个上限只挡异常大的输入：1 倍不到的超分本来也没意义（大图本身就够清楚）。
    const maxInput = Math.max(1, Math.floor(MAX_OUTPUT_SIDE / spec.scale));
    let pipeline = sharp(options.imagePath).rotate();
    if (Math.max(srcW, srcH) > maxInput) {
      pipeline = pipeline.resize({ width: maxInput, height: maxInput, fit: "inside", kernel: "lanczos3" });
    }
    const { data: rgb, info } = await pipeline
      .removeAlpha()
      .toColourspace("srgb")
      .raw()
      .toBuffer({ resolveWithObject: true });
    const width = info.width;
    const height = info.height;
    if (info.channels !== 3) {
      throw new Error(`源图解码得到 ${info.channels} 通道，期望 3（RGB）`);
    }

    // 相邻块留一条重叠带，拼接时加权平均 —— 否则 modelSide（常为 512）的硬拼缝
    // 在照片上是很明显的横竖条纹。重叠取侧边的 1/8（夹在 8..side-1）。
    const overlap = Math.min(Math.max(8, Math.round(modelSide / 8)), modelSide - 1);
    const grid = planTileGrid(width, height, modelSide, overlap);
    const coords = tileCoords(grid, width, height);

    const inferenceStart = Date.now();
    const tiles: { coord: TileCoord; rgb: Uint8Array }[] = [];
    let doneTiles = 0;
    options.onProgress?.({ done: 0, total: coords.length });
    for (const coord of coords) {
      // 1) 从整图抠出这一个 tile（RGB 已在内存，按坐标切片，不必重编码）
      const patch = extractRegion(rgb, width, height, coord.x, coord.y, coord.srcW, coord.srcH);
      // 2) 补到 modelSide×modelSide（**右下补零**，不是居中）：固定尺寸模型必须正好
      //    喂这个边长。补的零都在右下角，输出按 srcW×srcH 裁掉即可，不污染结果。
      const padded = new Uint8Array(modelSide * modelSide * 3);
      for (let yy = 0; yy < coord.srcH; yy += 1) {
        const srcStart = yy * coord.srcW * 3;
        const dstStart = yy * modelSide * 3;
        for (let xx = 0; xx < coord.srcW * 3; xx += 1) {
          padded[dstStart + xx] = patch[srcStart + xx] ?? 0;
        }
      }
      const tensor = new ort.Tensor(
        inputDtype,
        buildInputTensor(padded, modelSide, inputDtype),
        [1, 3, modelSide, modelSide],
      );
      const outputs = await session.run({ [inputName]: tensor });
      const out = outputs[outputName];
      if (!out) throw new Error("model returned no output");

      // fp16 模型的输出可能是 Float16Array（新 ORT）或 Uint16Array（旧 ORT），统一成 Float32。
      const outRgb = outputToFloat32(out.data as ArrayLike<number>);
      const srcOutW = coord.srcW * spec.scale;
      const srcOutH = coord.srcH * spec.scale;
      const u8 = floatToU8Rgb(outRgb, modelSide, coord.srcW, coord.srcH, spec.scale, 0, 0);
      tiles.push({
        coord: { ...coord, outW: srcOutW, outH: srcOutH },
        rgb: u8,
      });
      doneTiles += 1;
      options.onProgress?.({ done: doneTiles, total: coords.length });
    }
    const inferenceMs = Date.now() - inferenceStart;

    const stitched = blendTiles(width, height, spec.scale, tiles);
    const outDir = path.join(getDataDir("images"), "upscale");
    mkdirSync(outDir, { recursive: true });
    const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const outName = `${stamp}-x${spec.scale}.png`;
    const outPath = path.join(outDir, outName);
    await sharp(stitched.data, { raw: { width: stitched.width, height: stitched.height, channels: 3 } })
      .png({ compressionLevel: 6 })
      .toFile(outPath);

    const result: UpscaleResult = {
      outRef: `upscale/${outName}`,
      outUrl: "",
      width: stitched.width,
      height: stitched.height,
      model: modelId,
      scale: spec.scale,
      inferenceMs,
      totalMs: Date.now() - started,
    };
    logEvent({
      level: "info",
      source: "image",
      event: "upscale.done",
      message: `超分完成：${width}×${height} → ${stitched.width}×${stitched.height}（${modelId}×${spec.scale}）`,
      detail: { model: modelId, ws: width, hs: height, w: stitched.width, h: stitched.height, inferenceMs, totalMs: result.totalMs },
    });
    return { ok: true, result };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const cleared = clearCorruptModel(modelId, message);
    logEvent({
      level: "error",
      source: "image",
      event: "upscale.failed",
      message: `超分失败：${message}`,
      detail: { model: modelId, imagePath: options.imagePath, error: message, cleared },
    });
    return {
      ok: false,
      error: cleared
        ? `模型文件已损坏（${modelId}），已清除，请在模型列表里重新下载`
        : message,
    };
  }
}

/** 从 RGB 整图里按坐标切出一块。 */
export function extractRegion(
  rgb: Uint8Array | Buffer,
  width: number,
  height: number,
  x: number,
  y: number,
  w: number,
  h: number,
): Uint8Array {
  const out = new Uint8Array(w * h * 3);
  for (let yy = 0; yy < h; yy += 1) {
    const srcStart = ((y + yy) * width + x) * 3;
    const dstStart = yy * w * 3;
    for (let xx = 0; xx < w; xx += 1) {
      const s = srcStart + xx * 3;
      const d = dstStart + xx * 3;
      out[d] = rgb[s] ?? 0;
      out[d + 1] = rgb[s + 1] ?? 0;
      out[d + 2] = rgb[s + 2] ?? 0;
    }
  }
  return out;
}

/**
 * NCHW 浮点输出（padSide×padSide，值域 [0,1]）→ 8 位 RGB，裁掉补零带来的空白。
 *
 * 推理时我们把每个 tile 补成 padSide 方形再喂模型，输出自然是 padSide×scale 方形，
 * 实际要用的只是正中央的 srcW×srcH 那块（偏置 ox/oy 与补零时一致）。不裁的话，
 * 拼接出来的大图边缘会带上补零产生的黑边。
 */
export function floatToU8Rgb(
  nchw: Float32Array,
  padSide: number,
  srcW: number,
  srcH: number,
  scale: number,
  ox: number,
  oy: number,
): Uint8Array {
  const outSide = padSide * scale;
  const ow = srcW * scale;
  const oh = srcH * scale;
  const offX = ox * scale;
  const offY = oy * scale;
  const out = new Uint8Array(ow * oh * 3);
  for (let yy = 0; yy < oh; yy += 1) {
    for (let xx = 0; xx < ow; xx += 1) {
      const idx = (offY + yy) * outSide + (offX + xx);
      const d = (yy * ow + xx) * 3;
      out[d] = clamp255(nchw[idx] ?? 0);
      out[d + 1] = clamp255(nchw[outSide * outSide + idx] ?? 0);
      out[d + 2] = clamp255(nchw[outSide * outSide * 2 + idx] ?? 0);
    }
  }
  return out;
}

function clamp255(v: number): number {
  const n = v < 0 ? 0 : v > 1 ? 1 : v;
  return Math.round(n * 255);
}

const CORRUPT_MODEL_ERROR =
  /protobuf parsing failed|invalid protobuf|Failed to load model|INVALID_PROTOBUF/i;

function clearCorruptModel(id: string, message: string): boolean {
  if (!CORRUPT_MODEL_ERROR.test(message)) return false;
  if (isDownloadInFlight(id)) return false;
  const dest = upscaleModelPath(id);
  if (!dest) return false;
  try {
    removePartialFiles(dest);
    logEvent({
      level: "warn",
      source: "image",
      event: "upscale.model.corrupt",
      message: `超分模型文件损坏，已清除：${id}`,
      detail: { model: id, error: message },
    });
    return true;
  } catch {
    return false;
  }
}

/** 测试用：丢掉会话缓存与运行时单例。 */
export function resetUpscaleRuntime(): void {
  sessionCache = null;
  ortPromise = null;
}
