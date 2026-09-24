import type { Subprocess } from "bun";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "fs";
import { basename, dirname, join } from "path";
import { EMBEDDING_PORT_BASE } from "../../shared/engines";
import { getModelProfile, type ServerArgs } from "../../shared/model-profiles";
import { parseComputeBufferBytes, parseFlashAttnState, parseKvCacheBytes } from "../../shared/llama-log";
import { logEvent } from "../app-log";
import {
  EMBEDDING_POOLING_VALUES,
  getSetting,
  setServerFlashAttnEffective,
  type SettingsKey,
} from "../db/settings";
import { hasUnfinishedDownload } from "../downloader";
import {
  buildLaunchPlanKeyFromSettings,
  cachedLaunchPlan,
  refreshLaunchPlan,
  type LaunchPlan,
  type LaunchPlanKey,
} from "../launch-plan";
import { llamaCppBinaryPath, llamaCppLegacyBinaryPath } from "../engine-paths";
import { isMmprojFile, mainGgufInDir, modelNameForPath } from "../model-scan";
import { slugModelFileName } from "../model-store";
import { markServerStarted } from "../stats";
import { extractStartupError } from "./errors";
import {
  cachedFlashAttnSupport,
  cachedServerHelpSupport,
  flashAttnArgs,
  probeServerHelp,
  type FlashAttnSupport,
} from "./llama-flash-attn";
import { loadModeArgs, loadModeUnsupported, type LoadModeSupport } from "./llama-load-mode";
import { MAX_LOG_CHARS, killProcessTree, pumpServerOutput, spawnServerProcess, waitExit } from "./proc";
import type {
  BinaryCheckResult,
  LogListener,
  Runtime,
  RuntimeOverrides,
  ServerStatus,
  StartResult,
  StatusListener,
} from "./types";

const DOWNLOAD_PATTERN = /download|fetch|pulling|(\d+(\.\d+)?)\s*%/i;

const COMMON_BINARY_PATHS = [
  "/opt/homebrew/bin/llama-server",
  "/usr/local/bin/llama-server",
];

/**
 * 按二进制路径进程级缓存的 `--help` 探测结果（load-mode 与 flash-attn 共用，一次子进程）。
 * 应用托管的那份与 `brew install` 那份版本可能不同，各自探各自的；同一份二进制不必
 * 每次启动都跑 --help。探测失败不落缓存（下回再试），同步路径按「还没探过」处理：
 * load-mode 记 unknown（按默认启动，不赌开关存在），flash-attn 记 none（不发参数，
 * 行为与加这个开关前逐字节一致）。
 */

export async function probeLoadModeSupport(binaryPath: string): Promise<LoadModeSupport> {
  return (await probeServerHelp(binaryPath)).loadMode;
}

/**
 * 同步读已探测到的 load-mode 结果（null = 还没探过）。
 *
 * 给 `buildCommandLine` 用：那个函数是同步的（界面要「可复制的命令」立刻出字），而探测
 * 要跑一次 `--help`。只要本次会话里启动过一次（探测结果按路径缓存），界面复制的命令就
 * 与实际发出去的一致；没启动过则按默认（不发参数）显示 —— 不为了好看去赌版本。
 * 实现委托给 llama-flash-attn 的合并缓存（两个开关共用同一次 --help）。
 */
export function cachedLoadModeSupport(binaryPath: string): LoadModeSupport | null {
  const support = cachedServerHelpSupport(binaryPath);
  if (support === null) return null;
  return support.loadMode;
}

/**
 * 用户设置（三态）+ 上次实测 → 规划用的布尔（T4d 的计价规则）：
 *   off → false；on → true；
 *   auto → 实测 on→true，实测 off→false，未知（从没启动过）→ false（保守，
 *           宁可窗口小也不 OOM）。
 * 非法值（手改设置行塞进来的）按 auto 处理 —— 与 buildArgs 的白名单回落同口径。
 */
export function effectiveFlashAttnForPlan(
  setting: string | null | undefined,
  effective: "" | "on" | "off" | null | undefined,
): boolean {
  const s = (setting ?? "") as string;
  if (s === "off") return false;
  if (s === "on") return true;
  if (s !== "auto") {
    // 非枚举值 → 读侧回落 auto（与 buildArgs / updateSettings 的白名单一致）
  }
  const e = effective ?? "";
  if (e === "on") return true;
  if (e === "off") return false;
  return false; // 从没启动过 → 保守按关计价
}

function getSearchPath(): string {
  const home = process.env.HOME ?? "";
  const extra = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    home ? `${home}/.local/bin` : "",
    home ? `${home}/bin` : "",
  ].filter(Boolean);
  const current = process.env.PATH ?? "";
  return [...extra, current].join(":");
}

export const DEFAULT_CUSTOM_SERVER_ARGS: ServerArgs = {
  ctxSize: 8192,
  imageMaxTokens: 2048,
  batchSize: 256,
  ubatchSize: 64,
  parallel: 1,
  temp: 0.2,
  topP: 0.9,
  topK: 40,
  repeatPenalty: 1.12,
  repeatLastN: 256,
  noMmprojOffload: true,
};

/**
 * 与本地模型同目录的投影文件（mmproj）—— 多模态 GGUF 的**视觉塔**就装在这个独立文件里。
 *
 * 配对单位是**目录**：下载目录是「一个仓库一个目录」，同一目录里的所有量化共用
 * 同一个投影文件，所以同目录即配对，不问文件名（Unsloth 导出的就叫 `mmproj-F16.gguf`，
 * 名字里没有模型名可对）。多文件时优先 f16：bf16 的名字里也含 "f16" 子串，
 * 直接 includes 会选错，所以要求 f16 前面不是字母；都没有时退回字典序首个。
 *
 * 两道剔除是必须的 —— llama-server 遇到加载不了的投影文件会**直接退出**
 * （`[mtmd] failed to load multimodal model` → `exiting due to model loading error`，
 * 实测 0.4.0/b10809），所以一个坏文件足以把本来能跑的模型变成起不来的模型：
 *   - 没下完的（有侧车的半成品 / 内容为空）不配 —— 市场页的下载卡还在等着补它；
 *   - 头部不是 GGUF 魔数的（放错位置的杂物）不配。
 * 另一个真实风险是「投影文件是别的模型的」：文件本身合法、llama-server 却在加载
 * CLIP 时失败，这只能靠启动失败后去掉投影重试兜底（见 start()）。
 */
export function resolveMmprojFor(modelPath: string): string | null {
  const dir = dirname(modelPath);
  try {
    const candidates = readdirSync(dir).filter(isMmprojFile).sort();
    const usable = candidates.filter((n) => isUsableMmproj(join(dir, n)));
    const f16 = usable.find((n) => /(?:^|[^a-z])f16/i.test(n));
    const picked = f16 ?? usable[0];
    return picked ? join(dir, picked) : null;
  } catch {
    return null;
  }
}

/** 头部四个字节是 GGUF 魔数：清掉「放错位置 / 内容不是 gguf」的杂物。 */
function isUsableMmproj(filePath: string): boolean {
  // 有侧车且字节没齐 = 半成品：拿它启动必然加载失败，不如当作「还没有」。
  if (hasUnfinishedDownload(filePath)) return false;
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const head = Buffer.alloc(4);
    if (readSync(fd, head, 0, 4, 0) !== 4) return false;
    return head.toString("binary") === "GGUF";
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // 关不上只影响这个 fd，判据已经拿到了
      }
    }
  }
}

/**
 * 启动失败是不是「投影文件用不了」造成的。
 *
 * 只认 llama.cpp 自己打的那几句：mtmd / mmproj / CLIP / multimodal —— 这是决定
 * 要不要去掉 `--mmproj` 重试的唯一依据，判宽了会把「模型本身加载不了」也重试一遍
 * （多花一次加载时间，且第二次的报错会与第一次混在一起）。
 * 实测原文（0.4.0/b10809，文件坏与文件不匹配两种都是硬退出）：
 *   `E mtmd_init_from_file: error: Failed to load CLIP model from …/mmproj-f16.gguf`
 *   `E srv load_model: failed to load multimodal model, '…/mmproj-f16.gguf'`
 *   `E srv llama_server: exiting due to model loading error`
 */
export function isProjectorFailure(logs: string): boolean {
  return /mtmd|mmproj|clip_init|CLIP model|multimodal/i.test(logs);
}



/**
 * llama.cpp 的 `-m` 只收文件。目标是目录时（扫描器把「主模型 + mmproj」的 GGUF 仓库
 * 聚成了目录条目），换成目录里的主 GGUF；找不到就原样返回，让 llama-server 报它的错。
 * 见 `mainGgufInDir` 的注释 —— 那是一个真实起不来的模型。
 */
export function llamaLoadablePath(target: string): string {
  try {
    if (!statSync(target).isDirectory()) return target;
  } catch {
    return target;
  }
  return mainGgufInDir(target) ?? target;
}

export class LlamaRuntime implements Runtime {
  readonly id = "llama.cpp";
  readonly label = "llama-server";

  constructor(private readonly overrides: RuntimeOverrides = {}) {}

  private serverProcess: Subprocess | null = null;
  private serverStatus: ServerStatus = "stopped";
  private serverLogs = "";
  private lastError = "";
  private lastDownloadActivityAt = 0;
  /**
   * 带投影文件启动失败过一次 → 这次会话不再猜它（见 start() 的重试）。
   * 只在 stop() 里复位：用户看到「视觉不可用」的原因后去修文件 / 换模型，
   * 下一次显式重启就该重新配对，不该把一次失败钉死到进程生命周期。
   */
  private mmprojSuppressed = false;

  private logListeners = new Set<LogListener>();
  private statusListeners = new Set<StatusListener>();

  private setStatus(status: ServerStatus) {
    this.serverStatus = status;
    for (const cb of this.statusListeners) cb(status);
  }

  private appendLog(text: string) {
    this.serverLogs += text;
    if (this.serverLogs.length > MAX_LOG_CHARS) {
      this.serverLogs = this.serverLogs.slice(-MAX_LOG_CHARS);
    }
    if (DOWNLOAD_PATTERN.test(text)) {
      this.lastDownloadActivityAt = Date.now();
      if (this.serverStatus === "starting") this.setStatus("downloading");
    }
    for (const cb of this.logListeners) cb(text);
  }

  onLog(cb: LogListener): () => void {
    this.logListeners.add(cb);
    return () => this.logListeners.delete(cb);
  }

  onStatusChange(cb: StatusListener): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  getStatus(): ServerStatus {
    return this.serverStatus;
  }

  getPid(): number | undefined {
    return this.serverProcess?.pid;
  }

  getLogs(): string {
    return this.serverLogs;
  }

  getLastError(): string {
    return this.lastError;
  }

  /**
   * `--load-mode` / `--flash-attn` 的支持形态（null = 还没探测过）。探测在 start() 里、
   * buildArgs 之前做（一次 --help 出两个），结果按二进制路径缓存在进程级（同一份
   * llama-server 不必每次启动都跑 --help）。
   */
  private loadModeSupport: LoadModeSupport | null = null;
  private flashAttnSupport: FlashAttnSupport | null = null;
  /** 上次启动 llama.cpp 实际用的 flash attention（"" = 未知），供 auto 模式规划计价。 */
  private lastEffectiveFlashAttn: "" | "on" | "off" = "";
  /**
   * 自动启动参数（SERVER_AUTO_TUNE）的缓存 key：buildArgs / start 共用同一份，
   * 保证「复制的命令」与实际发出去的一致。
   */
  private launchPlanKey: LaunchPlanKey | null = null;

  clearLogs() {
    this.serverLogs = "";
  }

  async checkBinary(): Promise<BinaryCheckResult> {
    // 托管安装优先（引导页 / 设置里「一键安装」下到 <dataDir>/engines/llama.cpp/current）：
    // 官方构建、版本可查；用户自己装过的（Homebrew / PATH）仍然照用，不重复下载。
    // 兼容：本仓库更早的下载布局是 engines/llamacpp/current（无点），有就用它。
    const managed = llamaCppBinaryPath();
    if (existsSync(managed)) return { found: true, path: managed, mode: "managed" };
    const legacy = llamaCppLegacyBinaryPath();
    if (legacy && existsSync(legacy)) return { found: true, path: legacy, mode: "managed" };
    for (const p of COMMON_BINARY_PATHS) {
      try {
        const f = Bun.file(p);
        if (await f.exists()) return { found: true, path: p };
      } catch {
        // continue
      }
    }
    const p = Bun.which("llama-server", { PATH: getSearchPath() });
    return p ? { found: true, path: p } : { found: false };
  }

  /**
   * Resolve the model this instance serves.
   * Priority: explicit override (served-model registry) → locally installed GGUF path
   * → HF model reference (CUSTOM_HF_MODEL → profile).
   */
  private resolveModel(): { kind: "local"; path: string; alias: string } | { kind: "hf"; ref: string } {
    const target = this.overrides.model;
    if (target) {
      if (existsSync(target)) {
        return {
          kind: "local",
          path: llamaLoadablePath(target),
          alias: this.overrides.servedName ?? slugModelFileName(modelNameForPath(target)),
        };
      }
      return { kind: "hf", ref: target };
    }

    const localPath = getSetting("LOCAL_MODEL_PATH");
    if (localPath) {
      const name = getSetting("LOCAL_MODEL_NAME");
      const alias = name || localPath.split(/[\\/]/).pop()?.replace(/\.gguf$/i, "") || "model";
      return {
        kind: "local",
        path: llamaLoadablePath(localPath),
        alias: alias.toLowerCase().replace(/[^a-z0-9_.-]/g, "-"),
      };
    }

    const profileId = getSetting("VLLM_MODEL_PROFILE");
    const profile = getModelProfile(profileId);
    const hfModel = getSetting("CUSTOM_HF_MODEL") || profile?.hfModel;
    if (hfModel) return { kind: "hf", ref: hfModel };
    return { kind: "hf", ref: "" };
  }

  /** 公开（同进程内的 UI / 测试入口与 `buildCommandLine` 共用）：模型档案的 serverArgs。 */
  getProfileServerArgs(): ServerArgs {
    const profileId = getSetting("VLLM_MODEL_PROFILE");
    const profile = getModelProfile(profileId);
    return profile?.serverArgs ?? DEFAULT_CUSTOM_SERVER_ARGS;
  }

  /** 设置里是否开了「自动启动参数」：只认 "1"（set 时已做白名单，这里再收一遍）。 */
  private static isAutoTuneEnabled(): boolean {
    return getSetting("SERVER_AUTO_TUNE" as SettingsKey) === "1";
  }

  /**
   * 自动启动参数的缓存 key：设置（并发 / batch / ubatch / 缓存类型 / FA）+ 已解析的模型路径。
   * ctxOverride 固定为 null —— 自动模式下不把设置里的 ctx 当成「用户显式指定」，
   * 否则规划器会尊重它、自动推算就失去意义。flashAttn 按「设置值 + 上次实测」折算
   * （见 effectiveFlashAttnForPlan），unknown 时保守按关计价。
   * 非本地 GGUF（HF 引用 / 未解析到模型）没有可算的对象，返回 null。
   */
  private buildLaunchPlanKey(
    model: { kind: "local"; path: string; alias: string } | { kind: "hf"; ref: string },
  ): LaunchPlanKey | null {
    if (model.kind !== "local") return null;
    // key 的计算收敛在 launch-plan.ts（与测试共用同一份，见 buildLaunchPlanKeyFromSettings）。
    return buildLaunchPlanKeyFromSettings(
      model.path,
      (k) => getSetting(k as SettingsKey),
      effectiveFlashAttnForPlan(getSetting("SERVER_FLASH_ATTN"), this.lastEffectiveFlashAttn),
    );
  }

  /** 本次规划用的 FA 布尔（设置值 + 上次实测折算，见 effectiveFlashAttnForPlan）。 */
  private effectiveFlashAttnForPlan(): boolean {
    return effectiveFlashAttnForPlan(getSetting("SERVER_FLASH_ATTN"), this.lastEffectiveFlashAttn);
  }

  /**
   * 启动后的实测回读（T4e）：健康检查通过后从运行中的实例把「预测」之外的另一半
   * 数字捞回来 —— `/props` 的 n_ctx（每 slot 窗口）× total_slots = 总窗口、启动日志里
   * 的 flash attention 实际状态与 KV / compute buffer 实际字节数，然后记一条
   * `launch_plan.measured`（预测 vs 实测同框，以后校准公式的全部依据），并把
   * flash attention 实测值写进 SERVER_FLASH_ATTN_EFFECTIVE（下次 auto 规划就不再保守计价）。
   *
   * 任何一步失败都只是记 `launch_plan.readback_failed`（warn），**绝不影响启动结果**：
   * 回读是对已完成启动的补充记录，没有它启动依然是成功的。
   */
  private async readbackMeasured(): Promise<void> {
    const port = this.overrides.port ?? (getSetting("SERVER_PORT") || "8080");
    const detail: Record<string, string | number | null> = {
      model: basename(this.resolvedModelPath()),
    };

    const plan = this.autoPlan(this.resolveModel());
    if (plan !== null) {
      detail.predictedCtx = plan.ctxTokens;
      detail.predictedPerSlot = plan.ctxPerSlot;
      detail.predictedKv = plan.estimates.kvBytes;
    }

    const log = this.getLogs();
    const flash = parseFlashAttnState(log);
    detail.flashAttn = flash;
    if (flash !== null) {
      setServerFlashAttnEffective(flash);
      this.lastEffectiveFlashAttn = flash; // 本次会话的下一次规划立刻受益
    }

    const kv = parseKvCacheBytes(log);
    if (kv !== null) detail.actualKv = kv;
    const compute = parseComputeBufferBytes(log);
    if (compute !== null) detail.actualCompute = compute;

    let actualCtxPerSlot: number | null = null;
    let actualSlots: number | null = null;
    const propsRes = await fetch(`http://localhost:${port}/props`, {
      signal: AbortSignal.timeout(3000),
    });
    if (propsRes.ok) {
      const props = (await propsRes.json()) as {
        default_generation_settings?: { n_ctx?: number } | null;
        total_slots?: number;
      };
      actualCtxPerSlot = Number.isFinite(props.default_generation_settings?.n_ctx)
        ? Number(props.default_generation_settings?.n_ctx)
        : null;
      actualSlots = Number.isFinite(props.total_slots) ? Number(props.total_slots) : null;
      // n_ctx 是**每 slot**的窗口（--ctx-size 会在 slot 间均分），总窗口要乘回去
      if (actualCtxPerSlot !== null) detail.actualCtxPerSlot = actualCtxPerSlot;
      if (actualSlots !== null) detail.actualSlots = actualSlots;
      if (actualCtxPerSlot !== null && actualSlots !== null) {
        detail.actualCtxTotal = actualCtxPerSlot * actualSlots;
      }
    }

    logEvent({
      level: "info",
      source: "server",
      event: "launch_plan.measured",
      message: `llama.cpp 启动回读（${detail.model}）`,
      detail,
    });

    if (plan !== null && typeof detail.actualCtxTotal === "number") {
      const diff = Math.abs(plan.ctxTokens - detail.actualCtxTotal) / plan.ctxTokens;
      if (diff > 0.05) {
        logEvent({
          level: "warn",
          source: "server",
          event: "launch_plan.mismatch",
          message: `预测窗口与实测相差超过 5%（${detail.model}）`,
          detail: { model: detail.model, predictedCtx: plan.ctxTokens, actualCtxTotal: detail.actualCtxTotal },
        });
      }
    }
  }

  /** 本次启动解析到的本地模型路径（HF 引用 / 未解析 → 空串），回读日志的 model 字段用。 */
  private resolvedModelPath(): string {
    const model = this.resolveModel();
    return model.kind === "local" ? model.path : "";
  }

  /** 本次自动推算用的计划（同步读缓存）；未开自动 / 非 GGUF / 没算过 → null，调用方回落到设置值。
   *  key 由调用方传入（start 用自己缓存的这份；buildCommandLine 用模型现建），
   *  两处 key 同一模型时逐字段相同，保证「复制的命令」与实际发出去的一致。 */
  private autoPlan(model: {
    kind: "local";
    path: string;
    alias: string;
  } | {
    kind: "hf";
    ref: string;
  }): LaunchPlan | null {
    if (!LlamaRuntime.isAutoTuneEnabled()) return null;
    const key = this.launchPlanKey ?? this.buildLaunchPlanKey(model);
    if (key === null) return null;
    const plan = cachedLaunchPlan(key);
    return plan !== null && plan.ctxTokens > 0 ? plan : null;
  }

  /** 一行中文摘要（GiB 保留一位小数，reasons 只列 code）。 */
  private autoPlanLogLine(plan: LaunchPlan): string {
    const giB = (bytes: number) => (bytes / (1024 ** 3)).toFixed(1);
    const reasons = plan.reasons.map((r) => r.code);
    return (
      `[auto] 上下文 ${plan.ctxTokens}（每请求 ${plan.ctxPerSlot}，${plan.parallel} 并发）` +
      ` · KV ${giB(plan.estimates.kvBytes)} GiB · 预算 ${giB(plan.estimates.budgetBytes)} GiB` +
      (reasons.length > 0 ? ` · 依据: ${reasons.join(", ")}` : "")
    );
  }

  buildCommandLine(modelOverride?: string): string {
    let model: { kind: "local"; path: string; alias: string } | { kind: "hf"; ref: string };
    if (modelOverride) {
      if (existsSync(modelOverride)) {
        model = {
          kind: "local",
          path: modelOverride,
          alias: slugModelFileName(modelNameForPath(modelOverride)),
        };
      } else {
        model = { kind: "hf", ref: modelOverride };
      }
    } else {
      model = this.resolveModel();
    }
    // 用户终端直接跑原生命令，不带 macOS PTY 包装。
    const bin =
      [llamaCppBinaryPath(), llamaCppLegacyBinaryPath(), ...COMMON_BINARY_PATHS].find(
        (p) => p && existsSync(p),
      ) ?? "llama-server";
    return [bin, ...this.buildArgs(model, this.getProfileServerArgs())].join(" ");
  }

  /** 公开（`buildCommandLine` / `start` / 同进程内 UI 入口共用）：拼装 llama-server 参数。 */
  buildArgs(model:
    | { kind: "local"; path: string; alias: string }
    | { kind: "hf"; ref: string },
    serverArgs: ServerArgs): string[] {
    // llama.cpp 的端口设置键就是 SERVER_PORT（见 shared/engines.ts）。
    // 嵌入实例（purpose=embedding）回落到嵌入端口段（EMBEDDING_PORT，默认 18190），
    // 不碰聊天默认端点；聊天实例保持 SERVER_PORT 不变。
    const cleanNum = (raw: string, fallback: string): string => {
      const n = Number(raw);
      return raw.trim() !== "" && Number.isFinite(n) && n >= 0 && Number.isSafeInteger(n)
        ? String(n)
        : fallback;
    };
    // 数值型设置（ctx / batch / parallel / port / …）的注入防御：这些值会原样进 argv，而
    // 设置行可能被手改数据库 / 旧版本写入，所以统一收一遍 —— 解析不出有限非负整数就丢弃
    // （空串保持空，让 `|| 档案默认` 兜底；非法值同样落回默认而不是把字符串塞给引擎）。
    const embedding = this.overrides.purpose === "embedding";
    const port = this.overrides.port ?? (embedding
      ? cleanNum(getSetting("EMBEDDING_PORT") || "", String(EMBEDDING_PORT_BASE))
      : cleanNum(getSetting("SERVER_PORT") || "", "8080"));
    const host = getSetting("SERVER_HOST") || "127.0.0.1";
    // 自动启动参数（SERVER_AUTO_TUNE，默认关）：有计划时 --ctx-size / --batch-size /
    // --ubatch-size（仅聊天实例）用计划值；--parallel 仍用设置值（并发是用户的业务选择），
    // --cache-type-k/-v 保持设置值（它们参与计划 key 的计算，改了自然重算）。
    const autoPlan = this.autoPlan(model);
    const ctxSize = autoPlan
      ? String(autoPlan.ctxTokens)
      : cleanNum(getSetting("SERVER_CTX_SIZE") || "", String(serverArgs.ctxSize));
    const imageMaxTokens = cleanNum(
      getSetting("SERVER_IMAGE_MAX_TOKENS") || "",
      String(serverArgs.imageMaxTokens),
    );
    const batchSize = autoPlan
      ? String(autoPlan.batch)
      : cleanNum(getSetting("SERVER_BATCH_SIZE") || "", String(serverArgs.batchSize));
    const ubatchSize = autoPlan
      ? String(autoPlan.ubatch)
      : cleanNum(getSetting("SERVER_UBATCH_SIZE") || "", String(serverArgs.ubatchSize));
    const parallel = cleanNum(getSetting("SERVER_PARALLEL") || "", String(serverArgs.parallel));
    const temp = getSetting("SERVER_TEMP") || String(serverArgs.temp);
    const topP = getSetting("SERVER_TOP_P") || String(serverArgs.topP);
    // 采样参数一律「设置优先、模型档案兜底」：设置页显示的就是实际发出去的那份。
    // 用 || 而不是 ?? 是因为空字符串表示「没设过」，要落回档案的默认值。
    const topK = getSetting("SERVER_TOP_K") || String(serverArgs.topK);
    const repeatPenalty = getSetting("SERVER_REPEAT_PENALTY") || String(serverArgs.repeatPenalty);
    // 「自动（全卸载）」哨兵值：与 llama.cpp 引擎自身的 -1 同值（不传参数 = 引擎自己决定），
    // 这里额外接受 "" / "auto" 作为同义写法 —— 自动推算的 gpuLayers 建议只在用户没
    // 显式指定时采纳（哨兵 → 计划值；具体数字 → 听用户的）。具体数字要能被解析成
    // 有限整数才进 argv（手改设置行塞进来的垃圾值丢弃，行为等同哨兵 = 引擎自己决定）。
    const rawGpuLayers = getSetting("SERVER_GPU_LAYERS");
    const gpuAuto = rawGpuLayers === "-1" || rawGpuLayers === "" || rawGpuLayers.toLowerCase() === "auto";
    const gpuLayers =
      !gpuAuto && /^-?\d+$/.test(rawGpuLayers.trim()) && Number.isSafeInteger(Number(rawGpuLayers))
        ? rawGpuLayers
        : "";
    // llama.cpp 的 KV 量化枚举（`--help` 取值列表，与 settings 页下拉同源）：手改设置行
    // 塞进来的值不能进 argv，白名单之外一律不落参数（引擎用自己的默认）。
    const KV_CACHE_TYPES = new Set(["f32", "f16", "q8_0", "q4_0", "q4_1"]);
    const cacheTypeK = KV_CACHE_TYPES.has(getSetting("SERVER_CACHE_TYPE_K"))
      ? getSetting("SERVER_CACHE_TYPE_K")!
      : null;
    const cacheTypeV = KV_CACHE_TYPES.has(getSetting("SERVER_CACHE_TYPE_V"))
      ? getSetting("SERVER_CACHE_TYPE_V")!
      : null;
    // 池化方式同理：设置键在 set 时有枚举校验，这里再收一遍（db 被手改 / 旧值兜底）。
    const pooling = (EMBEDDING_POOLING_VALUES as readonly string[]).includes(
      getSetting("EMBEDDING_POOLING"),
    )
      ? (getSetting("EMBEDDING_POOLING") as string)
      : "last";
    // 嵌入模式的物理 batch（n_batch = n_ubatch）：取 ctx-size，即「塞得进上下文的
    // 文本就一定嵌得进去」。**不能沿用聊天调优的 256/64** —— llama.cpp 在
    // `--embeddings` 下会强制 n_batch = n_ubatch（显式传值才不会被压到 512），
    // 而物理 batch 就是单次能喂进模型的 token 上限：超过它的文档在 pooling=last 时
    // 触发 GGML 断言直接崩进程（SIGTRAP / exit 5），pooling=mean 时返回 500。
    // KB 导入的 markdown 轻松超过 512 token，这正是「导入即崩」的根因。
    // ctxSize 这里已是 cleanNum 收敛过的纯数字串，直接解析即可。
    const embedBatch = String(Number(ctxSize) || 8192);

    const args: string[] = [];

    if (model.kind === "local") {
      args.push("-m", model.path, "--alias", model.alias);
      // 多模态投影文件（mmproj）：本地模型按同目录自动配对。
      // **聊天实例与嵌入实例都要注入**：GGUF 的视觉塔本来就在这个独立文件里，不传
      // --mmproj 的 VLM 起得来、纯文本也正常，只有上传图片时被服务端拒（「该模型不支持
      // 多模态输入」）—— 用户看到的现场就是「提示缺 mmproj，可文件明明已经下好了」。
      // 判据是「同目录里有投影文件」而不是模型名：名字里根本没有视觉线索的模型
      // （`Qwen3.8-27B-Q4_K_M.gguf`）占多数，按名字猜只会把能用的视觉模型继续挡在门外。
      // hf ref 走 -hf 自管缓存，拿不到本地目录，不注入（Non-Goal）。
      const picked = this.mmprojSuppressed ? null : resolveMmprojFor(model.path);
      if (picked) args.push("--mmproj", picked);
    } else if (model.ref) {
      args.push("-hf", model.ref);
    }

    args.push(
      "--host",
      host,
      "--port",
      port,
      "--ctx-size",
      ctxSize,
    );

    // 嵌入模式裁剪的聊天参数：--temp/--top-p/--top-k/--repeat-penalty/--repeat-last-n/--image-max-tokens。
    if (!embedding) {
      args.push(
        "--image-max-tokens",
        imageMaxTokens,
      );
    }

    // KV 缓存类型只有白名单内的值才落参数（嵌入实例也发，两边都需要）；
    // 手改设置行塞进来的值一律不发，让引擎用自己的默认。
    args.push(
      "--parallel",
      parallel,
      "--batch-size",
      embedding ? embedBatch : batchSize,
      "--ubatch-size",
      embedding ? embedBatch : ubatchSize,
    );
    if (cacheTypeK) args.push("--cache-type-k", cacheTypeK);
    if (cacheTypeV) args.push("--cache-type-v", cacheTypeV);

    if (!embedding) {
      args.push(
        "--repeat-penalty",
        repeatPenalty,
        "--repeat-last-n",
        String(serverArgs.repeatLastN),
        "--temp",
        temp,
        "--top-p",
        topP,
        "--top-k",
        topK,
      );
    }

    // 嵌入实例追加嵌入开关与池化方式（llama.cpp 默认禁用嵌入端点，这就是 501 的根因）。
    if (embedding) {
      args.push(
        "--embeddings",
        "--pooling",
        pooling,
      );
    }

    if (gpuLayers && !gpuAuto) {
      args.push("--n-gpu-layers", gpuLayers);
    } else if (
      gpuAuto &&
      autoPlan !== null &&
      typeof autoPlan.gpuLayers === "number"
    ) {
      // 用户没显式指定层数（-1/空/auto = 交给引擎）时才采纳计划的建议值；
      // 填了具体数字就听用户的。gpuLayers === 0（没有 GPU）时引擎自己决定，不发参数。
      if (autoPlan.gpuLayers !== 0) args.push("--n-gpu-layers", String(autoPlan.gpuLayers));
    }

    // 加载模式（PERF-02）：权重 mmap / 锁内存的取舍 —— 系统内存紧张时是「换出去一点」
    // 还是「整机卡住」，由它决定。按 --help 探测结果决定发新版 --load-mode 还是旧版
    // 的 --mlock / --no-mmap（见 llama-load-mode.ts 的等价表）；界面复制的命令读同一份
    // 缓存，所以只要启动过一次，显示与实际发出去的就是同一串。
    const loadModeSupport =
      this.loadModeSupport ??
      cachedLoadModeSupport(
        [llamaCppBinaryPath(), ...COMMON_BINARY_PATHS].find((p) => existsSync(p)) ?? "llama-server",
      ) ??
      "unknown";
    args.push(...loadModeArgs(getSetting("SERVER_LOAD_MODE"), loadModeSupport));

    // flash attention（T4d）：三态开关按 --help 探测结果折算 —— 新版发 [--flash-attn, 值]，
    // 老版布尔开关只有 on 才发，没探测到就一个参数都不发（与加这个开关前逐字节一致）。
    // flashAttnArgs 自己把设置值收进白名单（非法值回落 auto），这里直传原始值。
    const rawFlash = getSetting("SERVER_FLASH_ATTN");
    const faSupport =
      this.flashAttnSupport ??
      cachedFlashAttnSupport(
        [llamaCppBinaryPath(), ...COMMON_BINARY_PATHS].find((p) => existsSync(p)) ?? "llama-server",
      ) ??
      "none";
    args.push(...flashAttnArgs(rawFlash, faSupport));

    if (serverArgs.noMmprojOffload) {
      args.push("--no-mmproj-offload");
    }

    const extra = getSetting("SERVER_EXTRA_ARGS");
    if (extra.trim()) args.push(...extra.trim().split(/\s+/));

    return args;
  }

  async start(): Promise<StartResult> {
    if (this.serverStatus === "running" || this.serverStatus === "starting" || this.serverStatus === "downloading") {
      return { ok: false, error: "Server already running" };
    }

    const serverArgs = this.getProfileServerArgs();

    const model = this.resolveModel();
    if (model.kind === "hf" && !model.ref) {
      return { ok: false, error: "No model configured" };
    }

    const binary = await this.checkBinary();
    if (!binary.found) {
      return { ok: false, error: "llama-server not found on PATH" };
    }
    const llamaPath = binary.path!;

    // 加载模式 + flash attention 共用一次 --help 探测（新版 --load-mode / 旧版 --mlock；
    // 三态 --flash-attn / 布尔 -fa / 没有），再拼参数。
    const helpSupport = await probeServerHelp(llamaPath);
    this.loadModeSupport = helpSupport.loadMode;
    this.flashAttnSupport = helpSupport.flashAttn;
    const loadMode = getSetting("SERVER_LOAD_MODE");
    if (loadModeUnsupported(loadMode, this.loadModeSupport)) {
      const message = `加载模式 ${loadMode} 在这台 llama-server（${this.loadModeSupport}）上不支持，本次按默认加载模式启动`;
      this.appendLog(`\n[omni] ${message}\n`);
      logEvent({
        level: "warn",
        source: "server",
        event: "engine.load_mode.unsupported",
        message,
        detail: { mode: loadMode, support: this.loadModeSupport, binary: llamaPath },
      });
    }

    // 自动启动参数：异步算一次、写进按 key 的缓存（buildArgs / buildCommandLine 只同步读）。
    // 任何失败都不能挡住启动 —— 计划缺失时全部回落设置值，与不开自动时逐字节一致。
    this.launchPlanKey = null;
    if (
      LlamaRuntime.isAutoTuneEnabled() &&
      model.kind === "local" &&
      /\.gguf$/i.test(model.path)
    ) {
      const key = this.buildLaunchPlanKey(model);
      if (key !== null) {
        try {
          await refreshLaunchPlan(key);
          this.launchPlanKey = key;
          const plan = cachedLaunchPlan(key);
          if (plan !== null && plan.ctxTokens > 0) {
            this.appendLog(`\n[omni] ${this.autoPlanLogLine(plan)}\n`);
          } else {
            this.appendLog("\n[omni] [auto] 未得到可用计划，本次启动按设置值\n");
          }
        } catch (e) {
          logEvent({
            level: "warn",
            source: "server",
            event: "launch_plan.failed",
            message: `自动启动参数计算失败（${e instanceof Error ? e.message : String(e)}），按设置值启动`,
            detail: { file: model.path },
          });
        }
      }
    }

    const args = this.buildArgs(model, serverArgs);
    const hadMmproj = args.includes("--mmproj");
    let result = await this.spawnAndWait(llamaPath, args);

    // 投影文件是按目录猜的，猜错的那一种（文件合法、但不是这个模型的）只有运行时
    // 才暴露：llama-server 在加载 CLIP 时失败并**直接退出**。没有这一步，一个放错
    // 位置的 mmproj 就能把本来跑得好好的模型变成"起不来"，而且报错还指向模型。
    // 去掉投影重试一次：视觉能力没了，模型可用 —— 这是可接受的降级，反过来不是。
    if (!result.ok && hadMmproj && isProjectorFailure(this.serverLogs)) {
      const reason = extractStartupError(this.serverLogs, "failed to load multimodal projector");
      this.mmprojSuppressed = true;
      const message = `投影文件（mmproj）加载失败，已去掉它重试 —— 本模型本次运行不接受图片输入。原因：${reason}`;
      this.appendLog(`\n[omni] ${message}\n`);
      logEvent({
        level: "warn",
        source: "server",
        event: "engine.mmproj.rejected",
        message,
        detail: { model: model.kind === "local" ? model.path : model.ref, reason },
      });
      result = await this.spawnAndWait(llamaPath, this.buildArgs(model, serverArgs));
    }

    return result;
  }

  /** 启动一次并等到就绪（或失败）。带投影与去掉投影的重试各调一次，别无他用。 */
  private async spawnAndWait(llamaPath: string, args: string[]): Promise<StartResult> {
    this.lastError = "";
    this.setStatus("starting");
    this.appendLog(`$ llama-server ${args.join(" ")}\n`);

    try {
      const usePty = process.platform === "darwin";
      const cmd = usePty
        ? ["script", "-q", "/dev/null", llamaPath, ...args]
        : [llamaPath, ...args];

      this.serverProcess = spawnServerProcess(cmd);
      pumpServerOutput(this.serverProcess, this.appendLog.bind(this));

      const self = this;
      this.serverProcess.exited
        .then((code) => {
          self.serverProcess = null;
          if (code === 0 || self.getStatus() === "stopped") {
            self.appendLog(`\n[server exited with code ${code}]\n`);
            self.setStatus("stopped");
          } else {
            self.lastError = extractStartupError(
              self.serverLogs,
              `Process exited with code ${code ?? 1}`,
            );
            self.appendLog(`\n[server exited with code ${code}]\n`);
            self.setStatus("error");
          }
        })
        .catch(() => {
          self.serverProcess = null;
          self.setStatus("error");
        });

      const port = this.overrides.port ?? (getSetting("SERVER_PORT") || "8080");
      const healthUrl = `http://localhost:${port}/health`;
      const maxIdleAttempts = 120;
      let idleCount = 0;
      this.lastDownloadActivityAt = 0;

      while (true) {
        await Bun.sleep(1000);
        const status = this.getStatus();
        if (status !== "starting" && status !== "downloading") break;
        try {
          const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
          if (res.ok) {
            this.setStatus("running");
            this.appendLog("\n[server is ready]\n");
            markServerStarted();
            // 启动后回读实测值（T4e）：任何失败只记日志，不影响上面的成功结果。
            try {
              await this.readbackMeasured();
            } catch (e) {
              logEvent({
                level: "warn",
                source: "server",
                event: "launch_plan.readback_failed",
                message: `启动回读失败（${e instanceof Error ? e.message : String(e)}），不影响已完成的启动`,
              });
            }
            return { ok: true };
          }
        } catch {
          // not ready yet
        }

        const downloadActive = Date.now() - this.lastDownloadActivityAt < 5000;
        if (downloadActive) {
          idleCount = 0;
        } else {
          idleCount += 1;
          if (idleCount >= maxIdleAttempts) break;
        }
      }

      const status = this.getStatus();
      if (status === "starting" || status === "downloading") {
        this.lastError = extractStartupError(
          this.serverLogs,
          "Server failed to become ready within timeout",
        );
        this.setStatus("error");
        return { ok: false, error: this.lastError };
      }

      return this.getStatus() === "running"
        ? { ok: true }
        : { ok: false, error: extractStartupError(this.serverLogs, this.lastError) };
    } catch (e) {
      this.lastError = String(e);
      this.setStatus("error");
      return { ok: false, error: this.lastError };
    }
  }

  async stop(): Promise<void> {
    // 用户显式停一次就是「重新配对」的时机：上一次因为投影文件起不来而压制的注入
    // 在这里复位，修好文件 / 换了模型再启动就会重新带上 --mmproj。
    this.mmprojSuppressed = false;
    if (!this.serverProcess) {
      this.setStatus("stopped");
      return;
    }

    const proc = this.serverProcess;
    this.setStatus("stopped");
    this.appendLog("\n[stopping server...]\n");

    killProcessTree(proc, "SIGTERM");

    const exited = await waitExit(proc, 5000);

    if (!exited) {
      killProcessTree(proc, "SIGKILL");
      await proc.exited.catch(() => {});
    }

    this.serverProcess = null;
  }

  async restart(): Promise<StartResult> {
    await this.stop();
    return this.start();
  }

  forceKill() {
    if (this.serverProcess) {
      try {
        killProcessTree(this.serverProcess, "SIGKILL");
      } catch {
        // already dead
      }
      this.serverProcess = null;
    }
  }
}