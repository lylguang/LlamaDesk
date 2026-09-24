/**
 * SystemOne 本地运行时的安装与常驻 worker（laya-mlx / MLX，Apple Silicon）。
 *
 * 与 `ppocr.ts` / `mlx-gen.ts` 同一套路：**托管 venv + 常驻 Python worker**。
 * - venv 装在 `<dataDir>/engines/laya`，`pip install laya-mlx` 一键装；
 * - worker 是 `systemone-laya-worker.py`，JSON-lines over stdio，按 weights 懒加载；
 * - 权重走 Hugging Face 缓存（默认 `~/.cache/huggingface`），**卸载只删 venv** ——
 *   引擎与权重分开，重装引擎不用重新下几百 MB 权重（与引擎目录的既有约定一致）。
 *
 * 平台限制是真实的：laya-mlx 依赖 MLX，只有 Apple Silicon 的 macOS 能跑。
 * 其他平台直接如实说"不支持"，而不是留一个装到一半的 venv。
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import path from "path";

import { logEvent } from "./app-log";
import { getSetting } from "./db/settings";
import { getDataDir } from "./paths";
import { proxyChildEnv } from "./proxy";
import { removeManifest, writeManifest } from "./install-manifest";

export type LayaPhase = "idle" | "installing" | "loading" | "ready" | "error";

export type LayaStatus = {
  /** 平台是否支持（Apple Silicon + macOS）。 */
  platformSupported: boolean;
  pythonPath: string | null;
  /** venv 建好且 laya-mlx 可导入。 */
  installed: boolean;
  /** 已安装的 laya-mlx 版本；未安装为空串。 */
  version: string;
  engineDir: string;
  workerRunning: boolean;
  phase: LayaPhase;
  phaseMessage: string;
};

export type LayaInstallResult = { ok: boolean; error?: string; version?: string };

// ---------------------------------------------------------------------------
// 事件（安装日志 / 阶段），主进程转发到前端
// ---------------------------------------------------------------------------

const logListeners = new Set<(text: string) => void>();
const phaseListeners = new Set<(phase: LayaPhase, message: string) => void>();

export function onLayaInstallLog(cb: (text: string) => void): () => void {
  logListeners.add(cb);
  return () => logListeners.delete(cb);
}

export function onLayaPhase(cb: (phase: LayaPhase, message: string) => void): () => void {
  phaseListeners.add(cb);
  return () => phaseListeners.delete(cb);
}

let currentPhase: LayaPhase = "idle";
let currentPhaseMessage = "";

function emitLog(text: string): void {
  for (const cb of logListeners) {
    try {
      cb(text);
    } catch {}
  }
}

function emitPhase(phase: LayaPhase, message = ""): void {
  currentPhase = phase;
  currentPhaseMessage = message;
  for (const cb of phaseListeners) {
    try {
      cb(phase, message);
    } catch {}
  }
}

/** 逐行读取子进程输出并转发到安装日志。 */
async function streamLines(stream: ReadableStream<Uint8Array>, onError = false): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) emitLog((onError ? "[stderr] " : "") + line.trimEnd());
    }
    if (buf.trim()) emitLog((onError ? "[stderr] " : "") + buf.trimEnd());
  } catch {
    // 流中断忽略
  }
}

// ---------------------------------------------------------------------------
// 目录 / Python 探测
// ---------------------------------------------------------------------------

export function platformSupported(): boolean {
  return process.platform === "darwin" && process.arch === "arm64";
}

/** venv 根目录（同时是引擎管理页展示的托管路径 / 卸载目标）。 */
export function layaEngineDir(): string {
  return getDataDir("engines", "laya");
}

export function layaEngineDirPath(): string {
  return layaEngineDir();
}

function venvBinary(name: string): string {
  return path.join(layaEngineDir(), "bin", name);
}

function installMarkerPath(): string {
  return path.join(layaEngineDir(), ".installing");
}

function workerScript(): string {
  // 打包后主进程塌缩成 bun/index.js，`import.meta.dir` 恒为 bun/，
  // 所以脚本必须与模块同名同目录，并在 electrobun.config.ts 的 copy 里列出。
  return path.join(import.meta.dir, "systemone-laya-worker.py");
}

function getSearchPath(): string {
  const home = process.env.HOME ?? "";
  const extra = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    home ? `${home}/.local/bin` : "",
    home ? `${home}/bin` : "",
  ];
  const current = process.env.PATH ?? "";
  return [...extra, current].join(":");
}

/** 返回 Python 的 minor 版本（3.x 中的 x），解析失败返回 null。 */
async function getPythonMinor(bin: string): Promise<number | null> {
  try {
    const proc = Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "pipe" });
    const m = `${proc.stdout} ${proc.stderr}`.toString().match(/Python\s+3\.(\d+)\./);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** 找系统 Python：laya-mlx 要求 >= 3.11（pyproject 的 requires-python）。 */
async function findPython(): Promise<string | null> {
  // 进程内只探一次：系统 Python 的位置在应用运行期间不会变，而这条路径每次调用都会走到
  // （resolveBackend 要判断本地运行时能不能用），每次都 spawn 四五个 `--version` 没必要。
  if (pythonCache !== undefined) return pythonCache;
  const candidates = ["python3.12", "python3.11", "python3.13", "python3"];
  for (const name of candidates) {
    const p = Bun.which(name, { PATH: getSearchPath() });
    if (!p) continue;
    const minor = await getPythonMinor(p);
    if (minor !== null && minor >= 11 && minor <= 13) {
      pythonCache = p;
      return p;
    }
  }
  pythonCache = null;
  return null;
}

/** 没有合规的系统解释器时，交给 uv 去取这个版本（它会下载并缓存一份）。 */
const UV_PYTHON_VERSION = "3.12";

/** `undefined` = 还没探过；`null` = 探过了但没有可用的 Python。 */
let pythonCache: string | null | undefined;

/** 装完依赖要重探一次 —— 否则刚装好的解释器会被上一次的"没有"挡住。 */
function resetPythonCache(): void {
  pythonCache = undefined;
}

/** 读取 venv 里已安装的 laya-mlx 版本（未安装返回 null）。 */
async function getLayaVersion(): Promise<string | null> {
  const py = venvBinary("python3");
  if (!existsSync(py)) return null;
  try {
    const proc = Bun.spawnSync(
      [py, "-c", "import importlib.metadata as m; print(m.version('laya-mlx'))"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = proc.stdout.toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 常驻 worker
// ---------------------------------------------------------------------------

type Pending = {
  resolve: (value: LayaPredictResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type LayaPredictResult =
  | { ok: true; response: unknown }
  | { ok: false; error: string; kind: "worker" | "timeout" };

/** spawn 配置 { stdout/stderr: "pipe", stdin: "pipe" } 时的子进程形态（同 mlx-gen）。 */
type PipeProc = {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  stdin: {
    write: (chunk: Uint8Array) => number | Promise<number>;
    flush?: () => void;
  };
  exited: Promise<number>;
  exitCode: number | null;
  kill: () => void;
};

type Worker = {
  proc: PipeProc;
  pending: Map<string, Pending>;
  nextId: number;
  /** worker 的启动握手：import 成功（`ready`）还是失败（`fatal` / 进程退出）。 */
  ready: Promise<boolean>;
  markReady: (ok: boolean) => void;
  /** 权重加载 / 推理阶段，界面拿来显示"首次加载中"。 */
  busy: boolean;
};

let worker: Worker | null = null;

function handleWorkerLine(line: string): void {
  const w = worker;
  if (!w) return;
  let obj: {
    id?: string;
    ok?: boolean;
    response?: unknown;
    error?: string;
    type?: string;
    phase?: string;
    message?: string;
    /** progress 事件用：哪个 repo、多少字节。 */
    weights?: string;
    bytes?: number;
  };
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }
  if (obj.type === "ready") {
    emitPhase("ready", "");
    w.markReady(true);
    return;
  }
  if (obj.type === "phase") {
    w.busy = obj.phase !== "loaded";
    emitPhase(obj.phase === "loaded" ? "ready" : "loading", obj.message ?? "");
    return;
  }
  if (obj.type === "fatal") {
    emitPhase("error", obj.error ?? "");
    logEvent({
      level: "error",
      source: "systemone",
      event: "systemone.laya.fatal",
      message: obj.error ?? "laya worker 启动失败",
    });
    w.markReady(false);
    return;
  }
  if (obj.type === "progress") {
    // 下载进度：真实的已落盘字节（worker 每 500ms 报一次）。
    if (obj.weights) {
      emitModelProgress({
        weights: String(obj.weights),
        phase: obj.phase === "done" ? "done" : "downloading",
        bytes: Number(obj.bytes ?? 0) || 0,
      });
    }
    return;
  }
  if (obj.type === "log") {
    if (obj.message) emitLog(String(obj.message));
    return;
  }
  const id = obj.id;
  if (!id) return;
  const pending = w.pending.get(id);
  if (!pending) return;
  w.pending.delete(id);
  clearTimeout(pending.timer);
  pending.resolve(
    obj.ok
      ? { ok: true, response: obj.response }
      : { ok: false, error: obj.error ?? "未知错误", kind: "worker" },
  );
}

function pumpWorkerStreams(w: Worker): void {
  void (async () => {
    const reader = w.proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) handleWorkerLine(line);
      }
    } catch {
      // worker 退出时流会中断，正常
    }
  })();
  void (async () => {
    const reader = w.proc.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true }).trim();
        if (text) emitLog(`[stderr] ${text}`);
      }
    } catch {
      // ignore
    }
  })();
}

/** worker 意外退出：把在飞的请求全部结算掉，否则界面要等到超时才知道失败。 */
function settleWorkerExit(w: Worker, code: number): void {
  for (const [id, pending] of w.pending) {
    clearTimeout(pending.timer);
    pending.resolve({ ok: false, error: `laya worker 退出（退出码 ${code}）`, kind: "worker" });
    w.pending.delete(id);
  }
  w.markReady(false);
  if (worker === w) worker = null;
  if (code !== 0) {
    logEvent({
      level: "error",
      source: "systemone",
      event: "systemone.laya.worker_exit",
      message: `laya worker 退出（退出码 ${code}）`,
      detail: { exitCode: code },
    });
  }
}

async function ensureWorker(): Promise<Worker | null> {
  if (worker && worker.proc.exitCode === null) {
    if (!(await worker.ready)) return null;
    return worker;
  }
  if (!platformSupported()) return null;
  const py = venvBinary("python3");
  if (!existsSync(py)) return null;
  let proc: PipeProc;
  try {
    proc = Bun.spawn([py, workerScript()], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
      // 权重首次加载要下 Hugging Face，必须继承代理设置（子进程只认环境变量）。
      // HF_ENDPOINT 走与 MLX 引擎同一把可调开关（默认 hf-mirror）：单设 HF_ENDPOINT
      // 而不用 snapshot_download 显式传 endpoint，是为了置空即回落官方 huggingface.co。
      env: {
        ...process.env,
        ...proxyChildEnv(),
        LAYA_DTYPE: getSetting("SYSTEMONE_LOCAL_DTYPE") || "float16",
        ...(() => {
          const hf = (getSetting("MLX_HF_ENDPOINT") || "").trim();
          return hf ? { HF_ENDPOINT: hf } : {};
        })(),
      },
    }) as unknown as PipeProc;
  } catch (e) {
    logEvent({
      level: "error",
      source: "systemone",
      event: "systemone.laya.spawn_failed",
      message: e instanceof Error ? e.message : String(e),
      detail: { error: e },
    });
    return null;
  }
  let settled = false;
  let resolveReady: (ok: boolean) => void = () => {};
  const ready = new Promise<boolean>((resolve) => {
    resolveReady = resolve;
  });
  const w: Worker = {
    proc,
    pending: new Map(),
    nextId: 0,
    ready,
    markReady: (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolveReady(ok);
    },
    busy: false,
  };
  worker = w;
  pumpWorkerStreams(w);
  void proc.exited.then((code) => settleWorkerExit(w, code ?? 0));
  emitPhase("loading", "");
  // 等 `ready`；import 失败时 worker 会发 fatal 并以非 0 退出，两条路都会结算。
  const ok = await Promise.race([
    ready,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30_000)),
  ]);
  if (!ok) {
    try {
      proc.kill();
    } catch {}
    if (worker === w) worker = null;
    if (currentPhase !== "error") {
      emitPhase("error", "laya 运行时启动失败（缺少 mlx / 不是 Apple Silicon？）");
    }
    return null;
  }
  return w;
}

/**
 * 发一条消息给 worker 并等它的同 id 回包。
 *
 * 超时不是"拿不到结果就丢"—— worker 仍在跑，这里只是不再等（下载尤其如此：
 * 断开界面不该把已经下了一半的权重丢掉）。
 */
/**
 * 拼一行请求帧。
 *
 * `id` **由这里统一生成，payload 不得覆盖**：`layaDownloadModel` 曾经自带一个
 * `id: "dl-<weights>"`，而这里以前写的是 `{ id, ...payload }` —— 展开把生成的 id
 * 盖掉了，于是 pending 表登记的是 `r1`、回包带的是 `dl-…`，两边永远对不上：
 * 权重明明下完了（进度都报到 done），调用方却一直等到超时，界面上就是"下载卡住"。
 */
export function workerFrame(id: string, payload: Record<string, unknown>): string {
  return `${JSON.stringify({ ...payload, id })}\n`;
}

async function sendToWorker(
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<LayaPredictResult> {
  const w = await ensureWorker();
  if (!w) {
    /*
     * 分清三种"起不来"，别拿一句"未安装或平台不支持"打发所有情况。
     *
     * 实测踩到的就是第三种：引擎装着、平台也对，worker 因为 import 失败启动不了，
     * 真实原因（`fatal` 带回来的那句）只进了安装日志，界面上却说"未安装" ——
     * 照着这句去查，方向从一开始就是错的。
     */
    if (!platformSupported()) {
      return { ok: false, error: "本地 JEV 运行时需要 Apple Silicon 的 macOS（MLX）", kind: "worker" };
    }
    if (!existsSync(venvBinary("python3"))) {
      return { ok: false, error: "laya 本地运行时还没安装：先点「安装引擎」", kind: "worker" };
    }
    const detail = currentPhase === "error" && currentPhaseMessage ? `：${currentPhaseMessage}` : "";
    return { ok: false, error: `laya 本地运行时启动失败${detail}`, kind: "worker" };
  }
  const id = `r${++w.nextId}`;
  const result = new Promise<LayaPredictResult>((resolve) => {
    const timer = setTimeout(() => {
      w.pending.delete(id);
      resolve({ ok: false, error: "本地运行时超时未响应", kind: "timeout" });
    }, timeoutMs);
    w.pending.set(id, { resolve, timer });
  });
  try {
    w.proc.stdin.write(new TextEncoder().encode(workerFrame(id, payload)));
    w.proc.stdin.flush?.();
  } catch (e) {
    const pending = w.pending.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      w.pending.delete(id);
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e), kind: "worker" };
  }
  return await result;
}

/**
 * 跑一次判定。
 *
 * 超时给到 10 分钟（`SYSTEMONE_LOCAL_TIMEOUT_MS`）：第一次调用还要下权重（几百 MB），
 * 按 HTTP 那套 60s 会一直超时。
 */
export async function layaPredict(
  payload: { model: string; weights: string; state: unknown; questions: unknown },
  timeoutMs?: number,
): Promise<LayaPredictResult> {
  const budget =
    timeoutMs ?? Math.max(30_000, Number(getSetting("SYSTEMONE_LOCAL_TIMEOUT_MS") || 0) || 600_000);
  return sendToWorker({ ...payload }, budget);
}

// ---------------------------------------------------------------------------
// 引擎页要的三件事：权重状态 / 下载权重 / 把权重装进内存
// ---------------------------------------------------------------------------

export type LayaModelState = {
  weights: string;
  downloaded: boolean;
  bytes: number;
  /** 已加载进 worker（「启动」过的那个）。 */
  loaded: boolean;
};

/** 权重下载进度（worker 每 500ms 报一次真实已落盘字节）。 */
export type LayaModelProgress = { weights: string; phase: "downloading" | "done"; bytes: number };

const modelProgressListeners = new Set<(p: LayaModelProgress) => void>();

export function onLayaModelProgress(cb: (p: LayaModelProgress) => void): () => void {
  modelProgressListeners.add(cb);
  return () => modelProgressListeners.delete(cb);
}

function emitModelProgress(p: LayaModelProgress): void {
  for (const cb of modelProgressListeners) {
    try {
      cb(p);
    } catch {}
  }
}

/**
 * 查各 repo 在本机的缓存状态。
 *
 * 只 `local_files_only` 探测，不会触发下载；但**要起 worker**（Python 才知道缓存布局），
 * 所以调用方（状态查询）应当缓存结果，而不是每次轮询都问一遍。
 */
export async function layaModelStates(
  repos: { weights: string }[],
): Promise<LayaModelState[]> {
  const result = await sendToWorker({ msg: "models", repos }, 60_000);
  if (!result.ok) return [];
  const payload = result.response as { items?: LayaModelState[]; loaded?: string[] } | null;
  const loaded = new Set(payload?.loaded ?? []);
  return (payload?.items ?? []).map((item) => ({ ...item, loaded: loaded.has(item.weights) }));
}

/** 下载权重到 Hugging Face 缓存（进度走 `onLayaModelProgress`）。 */
export async function layaDownloadModel(weights: string): Promise<LayaPredictResult> {
  // 下载没有上限超时：给 60 分钟，断在这也不影响 worker 继续下（缓存可续传）。
  // 不要在这里自带 id —— 请求 id 归 sendToWorker 管（见 workerFrame 的注释）。
  return sendToWorker({ msg: "download", weights }, 60 * 60_000);
}

/** 把权重加载成常驻实例（引擎页的「启动」）：不跑推理，只付出加载成本。 */
export async function layaLoadModel(weights: string): Promise<LayaPredictResult> {
  return sendToWorker({ msg: "load", weights }, 10 * 60_000);
}

/** 卸载单个常驻模型（不动 worker 进程）。 */
export async function layaUnloadModel(weights: string): Promise<LayaPredictResult> {
  return sendToWorker({ msg: "unload", weights }, 30_000);
}

/** 停止常驻 worker（释放内存）。 */
export async function stopLayaWorker(): Promise<{ ok: boolean }> {
  const w = worker;
  worker = null;
  if (!w) return { ok: true };
  try {
    w.proc.stdin.write(new TextEncoder().encode('{"msg":"quit"}\n'));
    w.proc.stdin.flush?.();
  } catch {}
  const t = setTimeout(() => {
    try {
      w.proc.kill();
    } catch {}
  }, 3000);
  try {
    await w.proc.exited;
  } catch {}
  clearTimeout(t);
  emitPhase("idle", "");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 状态 / 安装 / 卸载
// ---------------------------------------------------------------------------

export async function getLayaStatus(): Promise<LayaStatus> {
  const supported = platformSupported();
  // 装不装得起来看的是"有没有解释器来源"：系统 Python 或 uv，有一个就够。
  const pythonPath = supported
    ? ((await findPython()) ?? Bun.which("uv", { PATH: getSearchPath() }))
    : null;
  const version = await getLayaVersion();
  return {
    platformSupported: supported,
    pythonPath,
    installed: version !== null && existsSync(venvBinary("python3")),
    version: version ?? "",
    engineDir: layaEngineDir(),
    workerRunning: !!worker && worker.proc.exitCode === null,
    phase: currentPhase,
    phaseMessage: currentPhaseMessage,
  };
}

/**
 * 一键补齐依赖：装 uv。
 *
 * 为什么是 uv 而不是 Python：装 Python 要么让用户自己去装 Homebrew 和 python@3.12，
 * 要么我们去碰系统的解释器 —— 都不合适。uv 是单个二进制，装完它自己会按需下载并
 * 缓存合规的解释器（见 `UV_PYTHON_VERSION`），引擎安装那一步就能接着往下走。
 *
 * 优先用 Homebrew（这台机器上有的话，装出来的东西归 brew 管，用户后面好卸）；
 * 没有 brew 才用官方安装脚本装到 `~/.local/bin`。
 */
export async function installLayaDeps(): Promise<{ ok: boolean; error?: string; tool?: string }> {
  if (!platformSupported()) {
    return { ok: false, error: "本地 JEV 运行时需要 Apple Silicon 的 macOS（MLX），当前平台不支持" };
  }
  resetPythonCache();
  if (Bun.which("uv", { PATH: getSearchPath() }) || (await findPython())) {
    return { ok: true, tool: "already" };
  }
  const brew = Bun.which("brew", { PATH: getSearchPath() });
  const cmd = brew
    ? [brew, "install", "uv"]
    : ["/bin/sh", "-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"];
  emitPhase("installing", "安装 uv…");
  emitLog(`$ ${cmd.join(" ")}`);
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...proxyChildEnv() } });
  await Promise.all([streamLines(proc.stdout), streamLines(proc.stderr, true)]);
  const code = await proc.exited;
  resetPythonCache();
  const installed = Bun.which("uv", { PATH: getSearchPath() });
  if (code !== 0 || !installed) {
    logEvent({
      level: "error",
      source: "systemone",
      event: "systemone.laya.deps_failed",
      message: `安装 uv 失败（退出码 ${code}）`,
      detail: { viaBrew: !!brew, exitCode: code },
    });
    emitPhase("error", "依赖安装失败");
    return { ok: false, error: `安装 uv 失败（退出码 ${code}），详见安装日志` };
  }
  emitLog(`uv 已就绪：${installed}`);
  emitPhase("idle", "");
  return { ok: true, tool: brew ? "brew" : "script" };
}

let installInFlight: Promise<LayaInstallResult> | null = null;

/**
 * 一键安装本地运行时（venv + `pip install laya-mlx`）。
 *
 * 权重**不在这里下**：第一次请求时由 laya-mlx 自己拉进 Hugging Face 缓存，
 * 这样安装按钮很快就能返回，进度也在真正用到模型时才出现。
 */
export function installLayaRuntime(): Promise<LayaInstallResult> {
  if (installInFlight) return installInFlight;
  installInFlight = (async (): Promise<LayaInstallResult> => {
    if (!platformSupported()) {
      return { ok: false, error: "本地 JEV 运行时需要 Apple Silicon 的 macOS（MLX），当前平台不支持" };
    }
    const uv = Bun.which("uv", { PATH: getSearchPath() });
    const python = await findPython();
    /*
     * 有 uv 就不需要系统 Python。
     *
     * uv 自己会下载并管理解释器（`uv venv --python 3.12`），而这台机器上很可能只有
     * macOS 自带的 3.9 —— 以前在这里直接拦住，用户看到的是"未找到 Python 3.11–3.13"，
     * 明明装着 uv 却装不了引擎。系统 Python 合规时仍然优先用它（省一次 20 多 MB 的
     * 解释器下载）。
     */
    if (!uv && !python) {
      return {
        ok: false,
        error: "未找到 Python 3.11–3.13，也没有 uv。装其中一个即可（macOS: brew install python@3.12，或 brew install uv）",
      };
    }
    // 动任何文件之前先清掉上次的 manifest（与安装完成时的写入配对）。
    if (!removeManifest(layaEngineDir())) {
      const error = `无法清除上次的安装记录，请检查 ${layaEngineDir()} 是否被占用或只读`;
      emitLog(error);
      return { ok: false, error };
    }
    emitPhase("installing", "创建虚拟环境…");
    const engineDir = layaEngineDir();
    try {
      mkdirSync(engineDir, { recursive: true });
      writeFileSync(installMarkerPath(), String(Date.now()));
    } catch (e) {
      return { ok: false, error: `无法创建引擎目录：${e instanceof Error ? e.message : e}` };
    }

    const enginePython = venvBinary("python3");
    if (!existsSync(enginePython)) {
      /*
       * uv 的 `--python` 既收路径也收版本号：没有合规的系统解释器时就报版本，让它自己去取。
       *
       * `--clear` 只在目标已经是个 venv 时才用：上面刚往这个目录写了 `.installing` 标记，
       * 对 uv 来说这就是"非 venv 的非空目录"，它会直接拒绝清（`python -m venv --clear`
       * 不挑，所以这条路以前一直没露出来）。目录是新的就用 `--allow-existing`，
       * 让标记文件留着。
       */
      const looksLikeVenv = existsSync(path.join(engineDir, "pyvenv.cfg"));
      const cmd = uv
        ? [uv, "venv", looksLikeVenv ? "--clear" : "--allow-existing", "--python", python ?? UV_PYTHON_VERSION, engineDir]
        : [python as string, "-m", "venv", "--clear", engineDir];
      emitLog(`$ ${cmd.join(" ")}`);
      const venv = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
      if (venv.exitCode !== 0) {
        try {
          rmSync(installMarkerPath(), { force: true });
        } catch {}
        return { ok: false, error: venv.stderr.toString().slice(0, 500) || "创建虚拟环境失败" };
      }
    }

    emitPhase("installing", "安装 laya-mlx…");
    const mirror = "https://pypi.tuna.tsinghua.edu.cn/simple";
    const runInstall = async (indexArgs: string[]): Promise<number> => {
      const cmd = uv
        ? [uv, "pip", "install", "--python", enginePython, "--upgrade", "laya-mlx", ...indexArgs]
        : [venvBinary("pip3"), "install", "--upgrade", "laya-mlx", ...indexArgs];
      emitLog(`$ ${cmd.join(" ")}`);
      const proc = Bun.spawn(cmd, {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...proxyChildEnv() },
      });
      await Promise.all([streamLines(proc.stdout), streamLines(proc.stderr, true)]);
      return await proc.exited;
    };

    let code = await runInstall([]);
    if (code !== 0) {
      emitLog(`默认 PyPI 源安装失败（退出码 ${code}），改用清华镜像重试…`);
      code = await runInstall(["-i", mirror]);
    }
    try {
      rmSync(installMarkerPath(), { force: true });
    } catch {}
    if (code !== 0) {
      logEvent({
        level: "error",
        source: "systemone",
        event: "systemone.laya.install_failed",
        message: `laya-mlx 安装失败（退出码 ${code}）`,
        detail: { stage: "pip_install", exitCode: code },
      });
      emitPhase("error", "安装失败");
      return {
        ok: false,
        error: `laya-mlx 安装失败（退出码 ${code}）。可能是网络问题，请检查代理/网络后重试，详见安装日志。`,
      };
    }
    const version = await getLayaVersion();
    emitLog(version ? `安装成功：laya-mlx ${version}` : "安装成功");
    writeManifest(layaEngineDir(), {
      engine: "laya-mlx",
      version: version ?? null,
      platform: process.platform,
      arch: process.arch,
      steps: 2,
    });
    emitPhase("idle", "");
    return { ok: true, version: version ?? undefined };
  })().finally(() => {
    installInFlight = null;
  });
  return installInFlight;
}

/**
 * 卸载本地运行时：**只删托管的 venv**，权重（Hugging Face 缓存）保留 ——
 * 引擎与权重分开管，重装引擎不必重下几百 MB（与引擎管理页的约定一致）。
 */
export async function uninstallLayaRuntime(): Promise<{ ok: boolean; error?: string }> {
  await stopLayaWorker();
  const dir = layaEngineDir();
  if (!existsSync(dir)) return { ok: true };
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  emitPhase("idle", "");
  logEvent({ source: "systemone", event: "systemone.laya.uninstalled", message: `已卸载本地运行时：${dir}` });
  return { ok: true };
}
