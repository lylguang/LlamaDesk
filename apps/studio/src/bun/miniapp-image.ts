/**
 * 小应用里的"图"—— 参考图的会话白名单 + 生图模型目录 + 多帧合成为动图（GIF）。
 *
 * 这三件事都必须由**宿主**做，而且都必须带语义约束：
 *
 *  - **参考图**：小应用跑在 sandbox iframe 里，它能交出来的只有两种东西 ——
 *    "用户刚在系统对话框里选的文件路径"（判据与 OCR / 文档导入同一份）和
 *    "宿主在本次会话里签发给它的 ref"。后者就是本模块的会话表：没有它，
 *    `image.edit` 的 ref 参数等于给了 iframe 一个"把用户图库里的任意图片
 *    送去云端厂商"的接口（`gen/xxx.png` 也是合法 ref）。
 *    顺带解决了另一件事：一套表情要连续改 16 张同一张照片，每次调用都重新暂存
 *    就会在 `images/edit/in/` 里留下 16 份一模一样的副本，所以暂存结果按
 *    (应用, 路径) 缓存。
 *
 *  - **生图模型目录**：小应用要自己选模型（本地 / 云端），但"有哪些模型、哪个能跑"
 *    只有主进程知道（MLX 预设有哪几个、权重下没下、ComfyUI 连得上吗、哪些云厂商
 *    配了生图模型）。这里把它整理成一份**只读目录**发给页面，页面只报"我选了什么"，
 *    由宿主按目录校验 —— 小应用不碰设置、也不改写用户在生图页保存的配置。
 *
 *  - **GIF**：沙箱页面里没有编码器（也不该为一个页面装一个），多帧合成在这里用
 *    sharp 做：逐帧统一尺寸 → 合成为动画 GIF → 落进 `images/sticker/`，
 *    和生成图一样由媒体服务器对外提供。帧的 ref 同样只认本会话签发过的那批。
 *
 * 与 `bun/miniapps.ts` 同一条规矩：这里不 import electrobun，要能在 `bun test`
 * 里单独加载。
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import sharp from "sharp";

import { getImagesBaseDir } from "./image-server";
import { chatImageUrl } from "../shared/server-info";
import { safeJoin } from "./path-safety";
import { getImageGenConfig, listComfyCheckpoints, stageEditImage } from "./image-gen";
import type { ImageGenBackend } from "./image-gen";
import * as CloudProviders from "./cloud-providers";
import * as MlxGen from "./mlx-gen";
import { providerModelsOfType, providerConfigured } from "../shared/cloud-providers";
import { logEvent } from "./app-log";

// ---------------------------------------------------------------------------
// 会话 ref：宿主签发给某个小应用的图片引用
// ---------------------------------------------------------------------------

/**
 * 每个小应用一个集合：里面是**这个应用自己**在这次运行里产生过的 ref
 * （暂存进来的源图 + 它生成的每一张图）。
 *
 * 为什么要按应用分而不是全局一份：一个应用不该能把另一个应用刚生成的图当参考图
 * 送出去 —— 虽然都是本机产物，但"谁产出的谁能用"是这里唯一说得清的边界。
 */
const sessionRefs = new Map<string, Set<string>>();

/** 单个应用的会话上限：够一套 16 张表情来回用，又不至于让一张表无限长。 */
const MAX_REFS_PER_APP = 128;

export function rememberMiniAppRef(appId: string, ref: string): void {
  const id = appId.trim();
  const value = ref.trim();
  if (!id || !value) return;
  let set = sessionRefs.get(id);
  if (!set) {
    set = new Set();
    sessionRefs.set(id, set);
  }
  set.add(value);
  // 超限丢最旧的（Set 保持插入顺序）：一次会话里用不到的旧产物留着也没有意义。
  while (set.size > MAX_REFS_PER_APP) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

/** 这个 ref 是宿主签发给该应用的吗（不是就从 iframe 来的一串任意字符串）。 */
export function isSessionMiniAppRef(appId: string, ref: string): boolean {
  return sessionRefs.get(appId.trim())?.has(ref.trim()) ?? false;
}

/** 仅测试用：清掉会话表，避免用例之间互相影响。 */
export function resetMiniAppImageSessions(): void {
  sessionRefs.clear();
  stagedByPath.clear();
}

// ---------------------------------------------------------------------------
// 参考图暂存（同一张源图只暂存一次）
// ---------------------------------------------------------------------------

/**
 * (应用 + 源路径) → 暂存后的 ref。
 *
 * 一套 16 张表情都改同一张照片：不缓存的话每次调用都会往 `images/edit/in/`
 * 里拷一份新的（16 份重复文件，而且每条记录都指向不同副本）。
 */
const stagedByPath = new Map<string, string>();

export type StageMiniAppSourceResult =
  | { ok: true; ref: string; url: string }
  | { ok: false; error: string };

/**
 * 把用户选中的源图暂存进 `images/edit/in/`，返回可预览的 ref / URL。
 *
 * **调用方必须先过 `isDialogPickedPath`**（rpc 层做，与 OCR / 文档导入同一份判据）：
 * 这条路径直接来自 iframe，不校验就等于给了小应用一个"读磁盘任意文件"的接口。
 */
export async function stageMiniAppSource(
  appId: string,
  sourcePath: string,
): Promise<StageMiniAppSourceResult> {
  const key = `${appId}\n${sourcePath}`;
  const cached = stagedByPath.get(key);
  if (cached && existsSync(safeJoin(getImagesBaseDir(), cached) ?? "")) {
    rememberMiniAppRef(appId, cached);
    return { ok: true, ref: cached, url: chatImageUrl(cached) };
  }

  const staged = await stageEditImage([sourcePath]);
  const first = staged[0];
  if (!first) {
    return { ok: false, error: "这张图读不出来（支持 png / jpg / webp / bmp / heic）" };
  }
  // 简易上限：小应用一次会话里换不了几十张源图，超了整表清空（都是可重建的暂存副本）。
  if (stagedByPath.size > 64) stagedByPath.clear();
  stagedByPath.set(key, first.ref);
  rememberMiniAppRef(appId, first.ref);
  return { ok: true, ref: first.ref, url: first.url };
}

// ---------------------------------------------------------------------------
// 生图模型目录（页面自己选模型，宿主校验）
// ---------------------------------------------------------------------------

/** 一个可选模型：id 是发出去的取值，label 给人看，note 说明状态。 */
export type MiniAppImageModel = {
  id: string;
  label: string;
  /** 补充说明（体积 / 没下载 / 地址）。 */
  note?: string;
  /** 现在能不能直接用（MLX 权重是否已下载 / 厂商是否配好）。 */
  ready: boolean;
};

/**
 * 发给小应用的模型目录。
 *
 * `supportsReference` 由宿主给，而不是页面按后端名去猜：哪天 ComfyUI 那边接上
 * 图生图，翻这个开关就够了，页面里"用照片还是用描述"的分支不用动。
 */
export type MiniAppImageCatalog = {
  /** 生图页当前保存的选择 —— 页面打开时的默认值。 */
  current: { backend: ImageGenBackend; providerId: string; model: string };
  cloud: { providerId: string; name: string; models: MiniAppImageModel[] }[];
  local: { backend: ImageGenBackend; label: string; models: MiniAppImageModel[]; note?: string }[];
  supportsReference: Record<ImageGenBackend, boolean>;
};

/** 各后端能否吃参考图（以图改图）—— 唯一真源在这里，页面不猜。 */
const SUPPORTS_REFERENCE: Record<ImageGenBackend, boolean> = {
  api: true,
  // MLX 走 mflux 的文生图命令、ComfyUI 那套工作流是纯文生图：都不能吃参考图。
  mlx: false,
  comfyui: false,
};

/** 云端厂商里可用的生图模型（已启用 + 已配好 Key 的厂商才列）。 */
function cloudCatalog(): MiniAppImageCatalog["cloud"] {
  const out: MiniAppImageCatalog["cloud"] = [];
  for (const provider of CloudProviders.listEnabledCloudProviders()) {
    const models = providerModelsOfType(provider, "image");
    if (models.length === 0) continue;
    const ready = providerConfigured(provider);
    out.push({
      providerId: provider.id,
      name: provider.name,
      models: models.map((m) => ({
        id: m.id,
        label: m.id,
        // 未配 Key 的厂商也列出来（用户看得到"差一步"，补上 Key 就能用），
        // 但标成不可用，省得点了才收到 401。
        note: ready ? undefined : "未填 API Key",
        ready,
      })),
    });
  }
  return out;
}

/** 本地两个后端：MLX（mflux 预设，看权重下没下）与 ComfyUI（现拉 checkpoint 列表）。 */
async function localCatalog(): Promise<MiniAppImageCatalog["local"]> {
  const cfg = getImageGenConfig();
  const groups: MiniAppImageCatalog["local"] = [];

  try {
    const status = await MlxGen.getMlxGenStatus();
    const downloaded = new Set(await MlxGen.getDownloadedMlxModels());
    groups.push({
      backend: "mlx",
      label: "MLX",
      note: !status.supported
        ? "仅支持 Apple Silicon macOS"
        : status.engineInstalled
          ? undefined
          : "引擎未安装（设置 → 模型引擎）",
      models: MlxGen.MLX_MODELS.map((m) => ({
        id: m.id,
        label: m.label,
        note: downloaded.has(m.id) ? undefined : `未下载 · 约 ${m.approxSizeGb}GB`,
        ready: status.supported && status.engineInstalled && downloaded.has(m.id),
      })),
    });
  } catch (e) {
    logEvent({
      level: "warn",
      source: "miniapp",
      event: "miniapp.image.mlx_probe_failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }

  // ComfyUI 的模型清单在服务器上：地址没填或连不上就只回一句状态，不抛。
  if (cfg.comfyBase) {
    try {
      const names = await listComfyCheckpoints(cfg.comfyBase);
      groups.push({
        backend: "comfyui",
        label: "ComfyUI",
        models: names.map((name) => ({ id: name, label: name, ready: true })),
        note: names.length === 0 ? "这台服务上没有 checkpoint" : undefined,
      });
    } catch (e) {
      groups.push({
        backend: "comfyui",
        label: "ComfyUI",
        models: [],
        note: `连不上：${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  return groups;
}

/**
 * 小应用能用的生图模型目录。**只读**：一个字段都不写回设置 ——
 * 小应用里换模型不该改写用户在生图页保存的那份配置。
 */
export async function listMiniAppImageModels(): Promise<MiniAppImageCatalog> {
  const cfg = getImageGenConfig();
  const [local] = await Promise.all([localCatalog()]);
  return {
    current: { backend: cfg.backend, providerId: cfg.providerId, model: cfg.model },
    cloud: cloudCatalog(),
    local,
    supportsReference: SUPPORTS_REFERENCE,
  };
}

/** 模型 id 的字符集：云端厂商的 id 形态五花八门（含 `/` `:` `.` `-`），只挡明显不对的。 */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;

/** ComfyUI 的 checkpoint 名：允许子目录，但不允许 `..` 与绝对路径（会指向服务器上别的文件）。 */
function safeCheckpointName(name: string): string | null {
  if (!MODEL_ID_RE.test(name)) return null;
  if (name.includes("..") || name.startsWith("/")) return null;
  return name;
}

export type MiniAppImageChoice =
  | {
      ok: true;
      /** 要覆盖的生图配置（页面没选的部分不覆盖，落回用户已保存的值）。 */
      config: { backend?: ImageGenBackend; providerId?: string; model?: string };
      supportsReference: boolean;
    }
  | { ok: false; error: string };

/**
 * 校验页面报上来的模型选择。
 *
 * 页面只能"选"，不能"填任意字符串"：MLX 必须是预设 id（mflux 只认那几个），
 * 云端必须是已存在厂商行上的模型 id 形态，ComfyUI 的 checkpoint 名要过得去 ——
 * 这些值最终会拼进发给上游的请求 / ComfyUI 工作流，来自 iframe 的输入一律先过这里。
 * 一个都没给（老调用方）就完全按用户已保存的配置走，行为与从前一致。
 */
export function resolveMiniAppImageChoice(input: {
  backend?: unknown;
  providerId?: unknown;
  model?: unknown;
}): MiniAppImageChoice {
  const backend = typeof input.backend === "string" ? input.backend.trim() : "";
  const providerId = typeof input.providerId === "string" ? input.providerId.trim() : "";
  const model = typeof input.model === "string" ? input.model.trim() : "";

  if (!backend) {
    const cfg = getImageGenConfig();
    return { ok: true, config: {}, supportsReference: SUPPORTS_REFERENCE[cfg.backend] };
  }
  if (backend !== "api" && backend !== "mlx" && backend !== "comfyui") {
    return { ok: false, error: `不支持的生成后端：${backend.slice(0, 40)}` };
  }

  if (backend === "api") {
    if (providerId) {
      const provider = CloudProviders.getCloudProviderInfo(providerId);
      if (!provider) return { ok: false, error: "这个云厂商不存在（可能已被删除）" };
      if (!providerConfigured(provider)) {
        return { ok: false, error: `「${provider.name}」还没有配置 API Key` };
      }
    }
    if (model && !MODEL_ID_RE.test(model)) return { ok: false, error: "模型 id 格式不合法" };
    return {
      ok: true,
      config: { backend, providerId: providerId || undefined, model: model || undefined },
      supportsReference: SUPPORTS_REFERENCE.api,
    };
  }

  if (backend === "mlx") {
    if (model && !MlxGen.findMlxModel(model)) {
      return { ok: false, error: `未知的 MLX 模型：${model.slice(0, 60)}` };
    }
    return {
      ok: true,
      config: { backend, model: model || undefined },
      supportsReference: SUPPORTS_REFERENCE.mlx,
    };
  }

  if (model && !safeCheckpointName(model)) {
    return { ok: false, error: "ComfyUI 模型名格式不合法" };
  }
  return {
    ok: true,
    config: { backend, model: model || undefined },
    supportsReference: SUPPORTS_REFERENCE.comfyui,
  };
}

// ---------------------------------------------------------------------------
// 合成动图（GIF）
// ---------------------------------------------------------------------------

/** 合成参数的上限。页面（bridge）先夹一道，这里是权威 —— 两边同一套数字。 */
export const GIF_LIMITS = {
  minFrames: 2,
  maxFrames: 12,
  minSize: 96,
  maxSize: 1024,
  minDelayMs: 30,
  maxDelayMs: 2000,
  /** 单帧文件上限（解码前）：生成图都是 1024² 的 PNG，几 MB 属正常。 */
  maxFrameBytes: 24 * 1024 * 1024,
} as const;

export type MakeGifParams = {
  appId: string;
  /** 帧的 ref，按播放顺序（来回循环由调用方自己排好序列）。 */
  refs: string[];
  /** 每帧时长（毫秒）。 */
  delayMs?: number;
  /** 输出边长（正方形，逐帧等比缩放进这个方框）。 */
  size?: number;
};

export type MakeGifResult = {
  ok: boolean;
  ref?: string;
  url?: string;
  width?: number;
  height?: number;
  bytes?: number;
  frames?: number;
  error?: string;
};

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 把若干张静态图合成为一个动画 GIF。
 *
 * 逐帧先缩放进 `size`×`size` 的白底方框再合成，而不是先合成再 resize：
 * sharp 对"已 join 的动画输入"做 resize 会把动画塌成一帧（`pages` 变成 1），
 * 这一步没有报错、只是动图默默变成了静图 —— 试过才知道，所以顺序不能换。
 */
export async function makeMiniAppGif(params: MakeGifParams): Promise<MakeGifResult> {
  const appId = params.appId.trim();
  const refs = (params.refs ?? []).map((r) => String(r).trim()).filter((r) => r.length > 0);
  const size = clampInt(params.size, GIF_LIMITS.minSize, GIF_LIMITS.maxSize, 320);
  const delayMs = clampInt(params.delayMs, GIF_LIMITS.minDelayMs, GIF_LIMITS.maxDelayMs, 120);

  if (refs.length < GIF_LIMITS.minFrames) {
    return { ok: false, error: `至少要 ${GIF_LIMITS.minFrames} 帧才能合成动图` };
  }
  if (refs.length > GIF_LIMITS.maxFrames) {
    return { ok: false, error: `帧数过多（${refs.length}，上限 ${GIF_LIMITS.maxFrames}）` };
  }
  // 只认本会话签发过的 ref：这一条挡掉的是"把任意一张图库图片拿去合成"。
  const foreign = refs.filter((ref) => !isSessionMiniAppRef(appId, ref));
  if (foreign.length > 0) {
    logEvent({
      level: "warn",
      source: "miniapp",
      event: "miniapp.gif.rejected",
      message: "拒绝了不是本次会话产出的图片 ref",
      detail: { appId, foreign: foreign.slice(0, 5) },
    });
    return { ok: false, error: "这些图片不是本次生成的结果，请重新生成" };
  }

  const base = getImagesBaseDir();
  const resolved: string[] = [];
  for (const ref of refs) {
    const abs = safeJoin(base, ref);
    if (!abs || !existsSync(abs)) return { ok: false, error: `找不到这一帧的图片（${ref}）` };
    const bytes = statSync(abs).size;
    if (bytes > GIF_LIMITS.maxFrameBytes) {
      return {
        ok: false,
        error: `有一帧图片过大（${Math.round(bytes / 1024 / 1024)}MB）`,
      };
    }
    resolved.push(abs);
  }

  try {
    const frames: Buffer[] = [];
    for (const abs of resolved) {
      frames.push(
        await sharp(abs)
          .resize(size, size, { fit: "contain", background: "#ffffff" })
          .png()
          .toBuffer(),
      );
    }
    // delay 传数组：传单个数字时只有第一帧拿到时长，后面几帧是 0（会一闪而过）。
    const gif = await sharp(frames, { join: { animated: true } })
      .gif({ delay: frames.map(() => delayMs), loop: 0, colours: 128, effort: 3 })
      .toBuffer();

    const dir = path.join(base, "sticker");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const ref = `sticker/${randomUUID()}.gif`;
    const dest = safeJoin(base, ref);
    if (!dest) return { ok: false, error: "输出路径不可用" };
    writeFileSync(dest, gif);

    const meta = await sharp(gif, { animated: true }).metadata();
    logEvent({
      level: "info",
      source: "miniapp",
      event: "miniapp.gif.done",
      message: `合成动图：${frames.length} 帧 / ${size}px / ${delayMs}ms`,
      detail: { appId, ref, bytes: gif.length, frames: frames.length, size, delayMs },
    });
    return {
      ok: true,
      ref,
      url: chatImageUrl(ref),
      width: meta.width ?? size,
      // sharp 的动画元数据里 height 是"整条胶片"的高度（页高 × 帧数），
      // 小应用要的是单帧尺寸，所以按页高给。
      height: meta.pageHeight ?? size,
      bytes: gif.length,
      frames: frames.length,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logEvent({
      level: "error",
      source: "miniapp",
      event: "miniapp.gif.failed",
      message,
      detail: { appId, frames: refs.length, size, delayMs, error: e },
    });
    return { ok: false, error: message };
  }
}
