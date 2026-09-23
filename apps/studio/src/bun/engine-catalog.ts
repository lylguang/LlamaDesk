/**
 * 本地引擎的统一管理（设置 → 模型引擎）——「装了什么、占多大、怎么升、怎么卸」的唯一入口。
 *
 * 这里不新增任何安装逻辑：每个引擎的安装仍然是原来那个模块（`engine-install` /
 * `whisper-engine` / `tts-local` / `ppocr` / `ocr` / `mlx-gen` / `cloudflared`），
 * 本文件只做三件事：
 *  1. **探测**：把各子系统的状态函数归拢成同一种形状（`LocalEngineStatus`），
 *     界面因此不必知道 vLLM 是 venv、whisper.cpp 是 conda 包、cloudflared 是二进制；
 *  2. **派发**：安装 / 升级 / 卸载按 id 转到对应模块，并把过程并到统一推送链路
 *     （`engineInstallLog` / `engineInstallPhase`）上，界面只订阅这一条流；
 *  3. **收口**：同一时刻只允许一个安装或卸载在跑（pip 与 `rm -rf` 撞在一起只会互相踩），
 *     卸载前先停掉正在用它的服务。
 *
 * 两条不放松的规矩：
 *  - **卸载只动托管目录**（`<dataDir>/engines/<id>`）；PATH / brew / conda 上那份一律不碰
 *    （与 `engine-paths.ts` 的「谁装的谁删得掉」同一条）——所以系统安装状态的行不给卸载按钮；
 *  - **模型权重不跟着引擎删**：换个引擎不该让用户把几十 GB 重新下一遍，
 *    权重始终在各自的功能页管理（`LocalEngineSpec.modelsTarget` 指过去）。
 */
import { existsSync, readdirSync, rmSync } from "fs";
import { join } from "path";

import { engineInstallSupport, type InferenceEngine } from "../shared/engines";
import {
  LOCAL_ENGINE_SPECS,
  isInferenceEngineId,
  localEngineSpec,
  type LocalEngineId,
  type LocalEngineState,
  type LocalEngineStatus,
} from "../shared/local-engines";
import { logEvent } from "./app-log";
import * as Asr from "./asr";
import * as AsrAudioCpp from "./asr-audiocpp";
import * as Cloudflared from "./cloudflared";
import { getSetting } from "./db/settings";
import {
  llamaCppBinaryPath,
  llamaCppRootDir,
  pythonEngineDir,
  pythonEnginePython,
  type PythonEngineId,
} from "./engine-paths";
import * as EngineInstall from "./engine-install";
import * as MlxGen from "./mlx-gen";
import * as Served from "./model-servers";
import * as Ocr from "./ocr";
import * as PpOcr from "./ppocr";
import { createRuntime } from "./runtimes";
import * as Tunnel from "./tunnel";
import * as TTSLocal from "./tts-local";
import * as WhisperEngine from "./whisper-engine";

// ---------------------------------------------------------------------------
// 目录占用：du 优先（C 实现，几万个文件的 venv 也是百毫秒级），Windows 回退到遍历
// ---------------------------------------------------------------------------

/** 结果缓存 60s：4GB 的 venv 每切一次标签页重扫一遍太浪费。 */
const sizeCache = new Map<string, { at: number; bytes: number | null }>();
const SIZE_TTL_MS = 60_000;

export function invalidateEngineSizeCache(): void {
  sizeCache.clear();
}

/** 递归求和；条目数上限挡住"指到根目录"这类意外，超限返回已统计的部分。 */
function walkSize(dir: string): number {
  let total = 0;
  let budget = 400_000;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (budget-- <= 0) return total;
      const full = join(current, entry.name);
      try {
        // 符号链接不跟（venv 里可能指回系统 Python）。
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile()) total += Bun.file(full).size;
      } catch {
        // 读不到的条目跳过
      }
    }
  }
  return total;
}

async function rawDirSize(dir: string): Promise<number | null> {
  if (process.platform !== "win32") {
    try {
      const proc = Bun.spawn(["du", "-sk", dir], { stdout: "pipe", stderr: "ignore" });
      const [text, code] = await Promise.all([
        Bun.readableStreamToText(proc.stdout as ReadableStream<Uint8Array>),
        proc.exited,
      ]);
      if (code === 0) {
        const kb = Number(text.trim().split(/\s+/)[0]);
        if (Number.isFinite(kb)) return kb * 1024;
      }
    } catch {
      // 落到遍历
    }
  }
  return walkSize(dir);
}

/** 目录占用（不存在或算不出来为 null）。 */
export async function engineDirSize(dir: string): Promise<number | null> {
  if (!existsSync(dir)) return null;
  const hit = sizeCache.get(dir);
  if (hit && Date.now() - hit.at < SIZE_TTL_MS) return hit.bytes;
  const bytes = await rawDirSize(dir);
  sizeCache.set(dir, { at: Date.now(), bytes });
  return bytes;
}

// ---------------------------------------------------------------------------
// 探测
// ---------------------------------------------------------------------------

/** 托管目录在不在 → 状态。系统那份由调用方用各自的探测结果再判。 */
function stateOf(managedExists: boolean, systemFound: boolean): LocalEngineState {
  if (managedExists) return "managed";
  return systemFound ? "system" : "missing";
}

/** Python 引擎（vLLM / SGLang / MLX）的 venv 目录名。 */
const PYTHON_ENGINE_DIRS: Record<"vllm" | "sglang" | "mlx", PythonEngineId> = {
  vllm: "vllm",
  sglang: "sglang",
  mlx: "mlx-lm",
};

async function probeInference(id: InferenceEngine): Promise<LocalEngineStatus> {
  const bin = await createRuntime(id).checkBinary();
  // 「应用自己装的那份」只看托管路径在不在，不看 runtime 报的 mode：`mode === "python"`
  // 在 vLLM / SGLang / MLX 上同时覆盖"托管 venv"和"系统里那个能 import 的 python"，
  // 拿它当判据会让系统装过的机器显示成"应用已安装"（并给出一个会删错东西的卸载按钮）。
  const managedDir = id === "llama.cpp" ? llamaCppRootDir() : pythonEngineDir(PYTHON_ENGINE_DIRS[id]);
  const managedBin = id === "llama.cpp" ? llamaCppBinaryPath() : pythonEnginePython(PYTHON_ENGINE_DIRS[id]);
  const managed = existsSync(managedBin);
  const support = engineInstallSupport(id);
  const running = Served.getServedModels().models.some((m) => m.engine === id && m.status !== "stopped");
  return {
    id,
    state: stateOf(managed, bin.found),
    version: EngineInstall.readInstalledEngineVersion(id),
    path: bin.path ?? null,
    managedDir: managed ? managedDir : null,
    sizeBytes: managed ? await engineDirSize(managedDir) : null,
    running,
    canInstall: support.supported,
    installNote: support.supported ? null : (support.note ?? null),
    approxBytes: support.approxBytes ?? null,
    requirement: support.requirement ?? null,
    canUninstall: managed,
    upgradeKind: "latest",
  };
}

async function probeWhisper(): Promise<LocalEngineStatus> {
  const info = await WhisperEngine.getWhisperEngineInfo();
  const managedDir = WhisperEngine.whisperEngineDir();
  const managed = existsSync(join(managedDir, "current"));
  const asr = await Asr.getAsrStatus();
  return {
    id: "whisper.cpp",
    state: stateOf(managed, info.installed),
    version: info.version,
    path: info.binaryPath,
    managedDir: managed ? managedDir : null,
    sizeBytes: managed ? await engineDirSize(managedDir) : null,
    running: asr.serverRunning,
    canInstall: info.supported,
    installNote: info.supported
      ? null
      : `当前平台（${process.platform}/${process.arch}）没有预编译包，请手动安装 whisper-cli / whisper-server 并加入 PATH`,
    approxBytes: 40e6,
    requirement: null,
    canUninstall: managed,
    // macOS 走 conda-forge 最新，其余平台是钉死的 Release：这里的「升级」= 重新下载一份，
    // 能修好被破坏的安装；真有新版本时也跟着上游走。
    upgradeKind: "repair",
  };
}

async function probeAudioCpp(): Promise<LocalEngineStatus> {
  const status = await TTSLocal.getTtsLocalStatus();
  const dir = TTSLocal.audioCppEngineDir();
  // 托管判定看目录本身（PATH 上那份不接管）；resolveBinary 只回答"能不能用"。
  const managed = existsSync(TTSLocal.audioCppEngineBin());
  const asr = await AsrAudioCpp.getAsrAudioCppStatus();
  const supported = TTSLocal.audioCppSupported();
  return {
    id: "audio.cpp",
    state: stateOf(managed, status.engineInstalled),
    version: managed ? status.version : null,
    path: status.binaryPath,
    managedDir: managed ? dir : null,
    sizeBytes: managed ? await engineDirSize(dir) : null,
    running: status.active || asr.active,
    canInstall: supported,
    installNote: supported
      ? null
      : `当前平台（${process.platform}/${process.arch}）没有预编译包，请手动安装 audiocpp_cli 并加入 PATH`,
    approxBytes: 30e6,
    requirement: null,
    canUninstall: managed,
    upgradeKind: "repair",
  };
}

async function probePaddleOcr(): Promise<LocalEngineStatus> {
  const status = await PpOcr.getPpOcrStatus();
  const dir = PpOcr.engineDirPath();
  return {
    id: "paddleocr",
    state: status.engineInstalled ? "managed" : "missing",
    version: status.version || null,
    path: status.engineDir,
    managedDir: status.engineInstalled ? dir : null,
    sizeBytes: status.engineInstalled ? await engineDirSize(dir) : null,
    running: status.workerRunning,
    canInstall: true,
    installNote: null,
    approxBytes: 900e6,
    requirement: "需要本机有 Python 3.10–3.12（应用会建独立虚拟环境安装）；识别模型分开下载",
    canUninstall: status.engineInstalled,
    upgradeKind: "repair",
  };
}

async function probeTesseract(): Promise<LocalEngineStatus> {
  const status = await Ocr.getOcrStatus();
  return {
    id: "tesseract",
    state: stateOf(false, status.tesseractInstalled),
    version: status.tesseractVersion || null,
    path: status.tesseractPath,
    managedDir: null,
    sizeBytes: null,
    running: status.engine === "tesseract",
    // 应用只能"帮你 brew 装一份"，装进的是用户的 Homebrew：这类引擎不接管升级与卸载。
    canInstall: process.platform === "darwin" || process.platform === "linux",
    installNote: null,
    approxBytes: null,
    requirement: "由 Homebrew 装到系统里，应用不接管它的升级与卸载",
    canUninstall: false,
    upgradeKind: "repair",
  };
}

async function probeMflux(): Promise<LocalEngineStatus> {
  const status = await MlxGen.getMlxGenStatus();
  const dir = MlxGen.engineDirPath();
  return {
    id: "mflux",
    state: status.engineInstalled ? "managed" : "missing",
    version: status.version,
    path: status.binDir,
    managedDir: status.engineInstalled ? dir : null,
    sizeBytes: status.engineInstalled ? await engineDirSize(dir) : null,
    running: MlxGen.getMlxActiveModel() !== null,
    canInstall: status.supported,
    installNote: status.supported ? null : "mflux 只在 Apple Silicon（arm64）的 macOS 上可用",
    approxBytes: 1.2e9,
    requirement: "需要本机有 Python 3.10+（应用会建独立虚拟环境安装）",
    canUninstall: status.engineInstalled,
    upgradeKind: "latest",
  };
}

async function probeCloudflared(): Promise<LocalEngineStatus> {
  const bin = Cloudflared.resolveCloudflared();
  const dir = Cloudflared.cloudflaredRootDir();
  const managed = bin?.source === "managed";
  const asset = Cloudflared.cloudflaredAssetFor(process.platform, process.arch);
  return {
    id: "cloudflared",
    state: stateOf(managed, !!bin),
    version: managed ? (bin?.version ?? Cloudflared.CLOUDFLARED_VERSION) : null,
    path: bin?.path ?? null,
    managedDir: managed ? dir : null,
    sizeBytes: managed ? await engineDirSize(dir) : null,
    running: Tunnel.getTunnelInfo().status === "running",
    canInstall: asset !== null,
    installNote: asset ? null : `当前平台（${process.platform}/${process.arch}）没有官方构建`,
    approxBytes: 40e6,
    requirement: null,
    canUninstall: managed,
    // 版本随应用内置（`CLOUDFLARED_VERSION`）：升级 = 重新下载这个版本。
    upgradeKind: "repair",
  };
}

async function probeEngine(id: LocalEngineId): Promise<LocalEngineStatus> {
  if (isInferenceEngineId(id)) return await probeInference(id);
  switch (id) {
    case "whisper.cpp":
      return await probeWhisper();
    case "audio.cpp":
      return await probeAudioCpp();
    case "paddleocr":
      return await probePaddleOcr();
    case "tesseract":
      return await probeTesseract();
    case "mflux":
      return await probeMflux();
    case "cloudflared":
      return await probeCloudflared();
  }
}

/** 全部引擎的状态（声明顺序 = 界面顺序）。 */
export async function listLocalEngines(): Promise<LocalEngineStatus[]> {
  startEngineLogBridge();
  return await Promise.all(LOCAL_ENGINE_SPECS.map((spec) => probeEngine(spec.id)));
}

// ---------------------------------------------------------------------------
// 日志桥：把各子系统自己的安装日志并到统一链路（engineInstallLog / engineInstallPhase）
// ---------------------------------------------------------------------------

let bridgeStarted = false;

/**
 * 只桥接**还没走统一链路**的来源（文本推理那四个本来就直发这条链路，再订阅一次
 * 等于自己转发自己）。桥接是进程级的，装一次就够。
 */
function startEngineLogBridge(): void {
  if (bridgeStarted) return;
  bridgeStarted = true;
  const relay = (text: string) => EngineInstall.publishEngineInstallLog(text);
  PpOcr.onPpOcrInstallLog(relay);
  Ocr.onTesseractInstallLog(relay);
  MlxGen.onInstallLog(relay);
  Cloudflared.onCloudflaredInstallLog(relay);
}

function emitPhase(id: LocalEngineId, phase: EngineInstall.InstallPhase, message: string, percent?: number | null): void {
  EngineInstall.publishEngineInstallPhase({ engine: id, phase, message, percent: percent ?? null });
}

// ---------------------------------------------------------------------------
// 同一时刻只允许一个安装 / 卸载
// ---------------------------------------------------------------------------

let busy: { id: LocalEngineId; op: "install" | "uninstall" } | null = null;

/** 正在装的引擎（引擎管理页刷新后据此恢复「进行中」）——与引导页共用同一个判据。 */
export function currentEngineJob(): { id: LocalEngineId; op: "install" | "uninstall" } | null {
  return busy;
}

export function clearEngineJobIf(id: LocalEngineId): void {
  if (busy?.id === id) busy = null;
}

function acquire(id: LocalEngineId, op: "install" | "uninstall"): { ok: true } | { ok: false; error: string } {
  const installingInference = EngineInstall.isEngineInstalling();
  if (installingInference) {
    return { ok: false, error: `正在安装 ${installingInference}，请等它装完` };
  }
  if (busy) {
    return {
      ok: false,
      error: `正在${busy.op === "install" ? "安装" : "卸载"} ${localEngineSpec(busy.id).name}，请等它结束`,
    };
  }
  busy = { id, op };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 安装 / 升级
// ---------------------------------------------------------------------------

export type LocalEngineInstallResult = { ok: boolean; error?: string; version?: string };

/** 这些引擎的安装器自己会发终态阶段（推理引擎的 `finish()`），外面别再补一条。 */
const INSTALLER_EMITS_TERMINAL: ReadonlySet<LocalEngineId> = new Set<LocalEngineId>([
  "llama.cpp",
  "vllm",
  "sglang",
  "mlx",
]);

/**
 * 装一个引擎；`upgrade` = 已经装过也重来一遍（拿到更新版本，或修复装坏的那份）。
 *
 * 升级与安装走同一条路：各引擎的"最新"来源不同（llama.cpp 是官方 Release，pip 引擎是
 * PyPI，whisper.cpp / audio.cpp / cloudflared 的版本钉在代码里），差别只体现在
 * `probe` 的 `upgradeKind` 上，界面据此把按钮叫「升级」还是「重新下载」。
 */
export async function installLocalEngine(
  id: LocalEngineId,
  options: { upgrade?: boolean } = {},
): Promise<LocalEngineInstallResult> {
  startEngineLogBridge();
  const spec = localEngineSpec(id);
  const upgrade = options.upgrade === true;
  const guard = acquire(id, "install");
  if (!guard.ok) return { ok: false, error: guard.error };

  const verb = upgrade ? "升级" : "安装";
  emitPhase(id, "preparing", `准备${verb} ${spec.name}`);
  try {
    const result = await dispatchInstall(id, upgrade);
    if (!INSTALLER_EMITS_TERMINAL.has(id)) {
      emitPhase(
        id,
        result.ok ? "done" : "failed",
        result.ok ? `${verb}完成：${spec.name}` : (result.error ?? `${verb}失败`),
      );
    }
    logEvent({
      level: result.ok ? "info" : "error",
      source: "server",
      event: result.ok ? "engine.manage.install.ok" : "engine.manage.install.failed",
      message: result.ok ? `${spec.name} ${verb}完成` : `${spec.name} ${verb}失败`,
      detail: { engine: id, upgrade, version: result.version, error: result.error },
    });
    invalidateEngineSizeCache();
    return { ok: result.ok, error: result.error, version: result.version };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (!INSTALLER_EMITS_TERMINAL.has(id)) emitPhase(id, "failed", error);
    logEvent({
      level: "error",
      source: "server",
      event: "engine.manage.install.failed",
      message: `${spec.name} ${verb}异常：${error}`,
      detail: { engine: id, upgrade, error },
    });
    return { ok: false, error };
  } finally {
    clearEngineJobIf(id);
  }
}

async function dispatchInstall(
  id: LocalEngineId,
  upgrade: boolean,
): Promise<{ ok: boolean; error?: string; version?: string }> {
  if (isInferenceEngineId(id)) {
    return await EngineInstall.installInferenceEngine(id, { upgrade });
  }
  switch (id) {
    case "whisper.cpp":
      emitPhase(id, "downloading", "下载 whisper.cpp 预编译包", null);
      return await WhisperEngine.downloadWhisperEngine({ upgrade });
    case "audio.cpp":
      emitPhase(id, "downloading", "下载 audio.cpp 预编译包", null);
      return await TTSLocal.downloadTtsLocalEngine({ upgrade });
    case "paddleocr":
      return await PpOcr.downloadPpOcrEngine();
    case "tesseract":
      return await Ocr.installTesseractEngine();
    case "mflux":
      // mflux 的安装器没有"已装就跳过"的短路，装到一半失败重跑也安全。
      return await MlxGen.downloadMlxEngine();
    case "cloudflared":
      return await Cloudflared.installCloudflared();
  }
}

// ---------------------------------------------------------------------------
// 卸载
// ---------------------------------------------------------------------------

export type LocalEngineUninstallResult = {
  ok: boolean;
  error?: string;
  /** 释放的字节数（算不出来为 null）。 */
  freedBytes?: number | null;
  /** 卸载前停掉的、正在用它的服务数量。 */
  stopped?: number;
};

/**
 * 卸载应用自己装的那份；系统安装的引擎这里一律拒绝（改 PATH 或 brew 是用户的事）。
 *
 * 卸载前先停掉正在用它的东西：推理服务 / ASR 服务 / OCR worker / 生图 worker 都持有
 * 那个二进制或解释器，删掉文件只是让它们在下一次请求时莫名其妙地失败。
 */
export async function uninstallLocalEngine(id: LocalEngineId): Promise<LocalEngineUninstallResult> {
  startEngineLogBridge();
  const spec = localEngineSpec(id);
  const guard = acquire(id, "uninstall");
  if (!guard.ok) return { ok: false, error: guard.error };

  try {
    const status = await probeEngine(id);
    if (!status.canUninstall || !status.managedDir) {
      return {
        ok: false,
        error: `没有可卸载的托管安装（应用不接管系统里那一份：${
          spec.uninstallHint ?? "请用系统的包管理器卸载"
        }）`,
      };
    }
    // cloudflared 是个例外：隧道正连着公网，静默停掉它比拒绝更让人意外。
    if (id === "cloudflared" && status.running) {
      return { ok: false, error: "远程访问隧道正在运行，请先在「远程访问」页停止隧道再卸载" };
    }

    emitPhase(id, "preparing", `正在卸载 ${spec.name}`);
    const stopped = await stopConsumers(id);
    const freedBytes = status.sizeBytes ?? (await engineDirSize(status.managedDir));
    const removed = await removeManagedInstall(id);
    if (!removed.ok) {
      emitPhase(id, "failed", removed.error ?? "卸载失败");
      logEvent({
        level: "error",
        source: "server",
        event: "engine.manage.uninstall.failed",
        message: `${spec.name} 卸载失败`,
        detail: { engine: id, dir: status.managedDir, error: removed.error },
      });
      return { ok: false, error: removed.error };
    }

    invalidateEngineSizeCache();
    logEvent({
      level: "info",
      source: "server",
      event: "engine.manage.uninstall.ok",
      message: `${spec.name} 已卸载（${status.managedDir}）`,
      detail: { engine: id, dir: status.managedDir, freedBytes, stopped },
    });
    emitPhase(id, "done", `已卸载：${spec.name}`);
    return { ok: true, freedBytes, stopped };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    emitPhase(id, "failed", error);
    logEvent({
      level: "error",
      source: "server",
      event: "engine.manage.uninstall.failed",
      message: `${spec.name} 卸载异常：${error}`,
      detail: { engine: id, error },
    });
    return { ok: false, error };
  } finally {
    clearEngineJobIf(id);
  }
}

/** 停掉正在用这个引擎的服务，返回停掉的数量。 */
async function stopConsumers(id: LocalEngineId): Promise<number> {
  if (isInferenceEngineId(id)) {
    const running = Served.getServedModels().models.filter(
      (m) => m.engine === id && m.status !== "stopped",
    );
    for (const model of running) {
      try {
        await Served.stopServedModel(model.id);
      } catch {
        // 停不掉也继续卸载：进程还活着是它自己的问题，不该把卸载卡死
      }
    }
    return running.length;
  }
  switch (id) {
    case "whisper.cpp": {
      const asr = await Asr.getAsrStatus();
      if (asr.serverRunning) {
        try {
          await Asr.stopAsr();
          return 1;
        } catch {
          return 0;
        }
      }
      return 0;
    }
    case "audio.cpp": {
      // 它没有常驻进程（每次请求现起一个 CLI），把设置里指向它的两处收回来就够了。
      const wasTts = getSetting("TTS_LOCAL_ENGINE") === "audio.cpp";
      const wasAsr = getSetting("ASR_ENGINE") === "audiocpp";
      return wasTts || wasAsr ? 1 : 0;
    }
    case "paddleocr":
    case "mflux":
      // 这两个的删除函数自己会先停 worker（cleanupPpOcrEngine / removeMlxEngine）。
      return 0;
    default:
      return 0;
  }
}

/** 真正删目录的那一步：只有托管目录，且由持有目录的那个模块来做。 */
async function removeManagedInstall(id: LocalEngineId): Promise<{ ok: boolean; error?: string }> {
  const fail = (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) });
  try {
    switch (id) {
      case "llama.cpp":
        // 连 current/ 与暂存目录一起删：只删 current/ 会把半截下载留在磁盘上。
        rmSync(llamaCppRootDir(), { recursive: true, force: true });
        return { ok: true };
      case "vllm":
      case "sglang":
      case "mlx":
        rmSync(pythonEngineDir(PYTHON_ENGINE_DIRS[id]), { recursive: true, force: true });
        return { ok: true };
      case "whisper.cpp":
        WhisperEngine.deleteWhisperEngine();
        return { ok: true };
      case "audio.cpp":
        return TTSLocal.removeAudioCppEngine();
      case "paddleocr":
        // 引擎与识别模型在同一个目录里：清 venv、留模型（模型在 OCR 页单独删）。
        return await PpOcr.cleanupPpOcrEngine();
      case "mflux":
        return await MlxGen.removeMlxEngine();
      case "cloudflared":
        return Cloudflared.removeCloudflared();
      case "tesseract":
        return { ok: false, error: "Tesseract 由系统包管理器安装，应用不接管卸载" };
    }
  } catch (e) {
    return fail(e);
  }
  return { ok: false, error: `未知引擎：${id}` };
}
