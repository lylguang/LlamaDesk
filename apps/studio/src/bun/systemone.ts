/**
 * SystemOne（JEV）服务 —— 本地与云端两个后端，一个调用入口。
 *
 * 三条调用路径（Agent 工具 / 界面面板 / 网关 `/v1/systemone`）**共用这一个函数**，
 * 所以"面板里跑出来的结果"和"外部 agent 通过网关拿到的东西"必然一致。
 *
 * 后端解析（`SYSTEMONE_BACKEND`）：
 * - `local`：只用本地。自建的 TypeSafe 兼容服务（`SYSTEMONE_LOCAL_BASE_URL`）优先，
 *   没配才用托管运行时（laya-mlx，Apple Silicon）；
 * - `cloud`：只用云端（TypeSafe 官方，或任何同协议的地址）；
 * - `auto`（默认值，只代表"用户没选过后端"）：本地能用就用本地，否则用云端。
 *
 * JEV 页左栏的「判定引擎」切换**直接写这个设置**（tab 就是后端选择），所以用户选定的
 * 那一侧是硬选择：选 `cloud` 时哪怕本地地址配着也不会被"本地优先"截走，选 `local` 时
 * 本地连不上也不会偷偷改走云端（回落只属于 `auto`）。
 *
 * 云端地址与 Key 走**独立设置项**，不复用 OpenAI 兼容的云厂商目录：TypeSafe 的
 * 协议与 OpenAI 形状不同（不是 /v1/chat/completions），塞进 `cloud_providers`
 * 会让"启用时探测 /v1/models"的既有逻辑误判。免费：价格恒为 0（见 shared/systemone.ts）。
 */

import { logEvent } from "./app-log";
import { getSetting } from "./db/settings";
import {
  getLayaStatus,
  layaModelStates,
  layaPredict,
  platformSupported,
  type LayaModelState,
} from "./systemone-laya";
import { providerLabelFor, recordUsageEvent } from "./usage";
import {
  SYSTEMONE_DEFAULT_MODEL,
  SYSTEMONE_MODELS,
  SYSTEMONE_PRICING,
  findSystemOneModel,
  findSystemOnePassthroughBases,
  parseSystemOneModelListing,
  systemOneAuthErrorBody,
  type SystemOneDiscoveredModel,
  type SystemOneModelListing,
  type SystemOneRequest,
  type SystemOneResponse,
} from "../shared/systemone";

export type SystemOneBackendKind = "cloud" | "local-url" | "local-runtime";

const DEFAULT_CLOUD_BASE = "https://api.typesafe.ai";
const DEFAULT_LOCAL_MODEL = "laya-latest";
const DEFAULT_TIMEOUT_MS = 60_000;

export type SystemOneConfig = {
  backend: "auto" | "cloud" | "local";
  cloudBaseUrl: string;
  cloudApiKey: string;
  cloudModel: string;
  localBaseUrl: string;
  localApiKey: string;
  localModel: string;
  timeoutMs: number;
};

function normalizeBackend(value: string): SystemOneConfig["backend"] {
  return value === "cloud" || value === "local" ? value : "auto";
}

/** 把用户填的地址归一化成 origin（去掉结尾斜杠与 `/v1`），拼接时我们自己加 `/v1/...`。 */
function normalizeBase(raw: string): string {
  const trimmed = (raw || "").trim().replace(/\/+$/, "");
  return trimmed.replace(/\/v1$/i, "");
}

export function systemOneConfig(): SystemOneConfig {
  return {
    backend: normalizeBackend(getSetting("SYSTEMONE_BACKEND")),
    cloudBaseUrl: normalizeBase(getSetting("SYSTEMONE_CLOUD_BASE_URL") || DEFAULT_CLOUD_BASE) || DEFAULT_CLOUD_BASE,
    cloudApiKey: getSetting("SYSTEMONE_CLOUD_API_KEY") || "",
    cloudModel: getSetting("SYSTEMONE_CLOUD_MODEL") || SYSTEMONE_DEFAULT_MODEL,
    localBaseUrl: normalizeBase(getSetting("SYSTEMONE_LOCAL_BASE_URL")),
    localApiKey: getSetting("SYSTEMONE_LOCAL_API_KEY") || "",
    localModel: getSetting("SYSTEMONE_LOCAL_MODEL") || DEFAULT_LOCAL_MODEL,
    timeoutMs: Math.max(1000, Number(getSetting("SYSTEMONE_TIMEOUT_MS") || 0) || DEFAULT_TIMEOUT_MS),
  };
}

// ---------------------------------------------------------------------------
// 结果类型
// ---------------------------------------------------------------------------

export type SystemOneSuccess = {
  ok: true;
  response: SystemOneResponse;
  backend: SystemOneBackendKind;
  /** 官方请求 id 形状，网关会把它放进 `x-typesafe-request-id` 响应头。 */
  requestId: string;
};

export type SystemOneFailure = {
  ok: false;
  /** HTTP 状态码，能直接回给客户端（云端失败时透传上游状态）。 */
  status: number;
  /** 官方形状的错误 body，可原样透传。 */
  body: unknown;
  message: string;
  backend: SystemOneBackendKind | null;
};

export type SystemOneResult = SystemOneSuccess | SystemOneFailure;

function failure(
  status: number,
  errorType: string,
  message: string,
  backend: SystemOneBackendKind | null,
): SystemOneFailure {
  return { ok: false, status, body: { detail: { error_type: errorType, message } }, message, backend };
}

// ---------------------------------------------------------------------------
// 模型解析
// ---------------------------------------------------------------------------

/**
 * 本地**托管运行时**（我们的 laya-mlx worker）用的目标：worker 要的是权重 repo 与一个
 * 回显用的版本标签，所以这里做名字归一化。
 *
 * 只给托管运行时用。**自建的本地服务不能归一化**（见 runSystemOne）：那是别人自己的
 * 服务器，模型名由它定义（很可能就叫 `jev-latest`），我们把名字改成 `laya-1` 反而会让
 * 它认不出来 —— 而"换掉 Base URL 就能用"正是本地服务这条路的意义。
 */
function resolveLocalRuntimeTarget(name: string, configured: string): { weights: string; version: string } {
  const wanted = findSystemOneModel(name);
  if (wanted?.backend === "local" && wanted.weights) return { weights: wanted.weights, version: wanted.version };
  const fallback = findSystemOneModel(configured);
  if (fallback?.backend === "local" && fallback.weights) {
    return { weights: fallback.weights, version: fallback.version };
  }
  // 允许直接把 Hugging Face repo id（或本地目录）填进 SYSTEMONE_LOCAL_MODEL。
  return { weights: configured, version: configured };
}

/**
 * 云端后端用的模型：本地专属名字（`laya-*`）云端不认识，换成云端默认模型 —— 这样
 * "只改了 Base URL/Key、模型还写着 laya-latest"的客户端不会撞上云端报错。
 * 完全不认识的名字原样透传，让官方 API 自己报错（掩盖拼写错误更糟）。
 */
function resolveCloudModel(name: string, configured: string): string {
  const known = findSystemOneModel(name);
  if (known?.backend === "local") return configured || SYSTEMONE_DEFAULT_MODEL;
  return name;
}

// ---------------------------------------------------------------------------
// 后端可用性
// ---------------------------------------------------------------------------

export type SystemOneAvailability = {
  backend: "auto" | "cloud" | "local";
  /** 这次调用实际会走哪条路；都没有能力时为 null。 */
  resolved: SystemOneBackendKind | null;
  cloudConfigured: boolean;
  localServerConfigured: boolean;
  localRuntimeInstalled: boolean;
  localRuntimeSupported: boolean;
  localRuntimeVersion: string;
  localRuntimeRunning: boolean;
  localRuntimePhase: string;
  localRuntimePhaseMessage: string;
  /** 价格恒为 0：JEV 在 OmniStudio 里免费。 */
  pricing: { inputPerMTok: number; outputPerMTok: number };
  models: typeof SYSTEMONE_MODELS;
  /**
   * 本地每个权重的缓存 / 加载状态（引擎页的模型行用）。
   * 运行时没装或平台不支持时为空数组 —— 界面据此显示"先装引擎"。
   */
  localModels: (LayaModelState & {
    name: string;
    version: string;
    release_date: string;
    /** 约体积，下载进度用它当分母（界面写「约」）。 */
    approxBytes: number;
  })[];
};

/** 解析这次调用会落到哪条路径上（也给界面显示"当前用哪个后端"）。 */
async function resolveBackend(cfg: SystemOneConfig): Promise<SystemOneBackendKind | null> {
  const runtimeInstalled = platformSupported() ? (await getLayaStatus()).installed : false;
  const cloudReady = !!cfg.cloudApiKey;
  if (cfg.backend === "local") {
    if (cfg.localBaseUrl) return "local-url";
    return runtimeInstalled ? "local-runtime" : null;
  }
  if (cfg.backend === "cloud") return cloudReady ? "cloud" : null;
  if (cfg.localBaseUrl) return "local-url";
  if (runtimeInstalled) return "local-runtime";
  return cloudReady ? "cloud" : null;
}

/** `auto` 下本地后端**连不上**时是否值得回落云端。 */
function worthCloudFallback(cfg: SystemOneConfig, failed: SystemOneFailure): boolean {
  // 只对"根本没连上/超时"回落：本地服务回了 422 说明它在正常工作，那是请求的问题，
  // 换云端只会把同一个错误再犯一遍（还要多花一次钱）。
  return (
    cfg.backend === "auto" &&
    !!cfg.cloudApiKey &&
    failed.backend !== "cloud" &&
    (failed.status === 502 || failed.status === 504)
  );
}

/** 状态查询会 spawn worker 探测缓存，这里缓存一小段时间，避免界面轮询把它打成高频操作。 */
const LOCAL_MODELS_TTL_MS = 5000;
let localModelsCache: { at: number; value: SystemOneAvailability["localModels"] } | null = null;

/** 引擎装/卸、下完权重、启动/停止之后要让下次查询重新探测。 */
export function invalidateLocalModels(): void {
  localModelsCache = null;
}

async function localModelStates(): Promise<SystemOneAvailability["localModels"]> {
  if (localModelsCache && Date.now() - localModelsCache.at < LOCAL_MODELS_TTL_MS) {
    return localModelsCache.value;
  }
  const repos = SYSTEMONE_MODELS.filter((m) => m.backend === "local" && m.weights).map((m) => ({
    weights: m.weights as string,
  }));
  const states = repos.length > 0 ? await layaModelStates(repos) : [];
  const byWeights = new Map(states.map((state) => [state.weights, state]));
  const value = SYSTEMONE_MODELS.filter((m) => m.backend === "local" && m.weights).map((m) => {
    const state = byWeights.get(m.weights as string);
    return {
      name: m.name,
      version: m.version,
      release_date: m.release_date,
      approxBytes: m.approxBytes ?? 0,
      weights: m.weights as string,
      downloaded: state?.downloaded ?? false,
      bytes: state?.bytes ?? 0,
      loaded: state?.loaded ?? false,
    };
  });
  localModelsCache = { at: Date.now(), value };
  return value;
}

export async function systemOneAvailability(): Promise<SystemOneAvailability> {
  const cfg = systemOneConfig();
  const supported = platformSupported();
  const laya = supported
    ? await getLayaStatus()
    : ({ installed: false, version: "", workerRunning: false, phase: "idle", phaseMessage: "" } as const);
  return {
    localModels: laya.installed ? await localModelStates() : [],
    backend: cfg.backend,
    resolved: await resolveBackend(cfg),
    cloudConfigured: !!cfg.cloudApiKey,
    localServerConfigured: !!cfg.localBaseUrl,
    localRuntimeInstalled: laya.installed,
    localRuntimeSupported: supported,
    localRuntimeVersion: laya.version,
    localRuntimeRunning: laya.workerRunning,
    localRuntimePhase: laya.phase,
    localRuntimePhaseMessage: laya.phaseMessage,
    pricing: { ...SYSTEMONE_PRICING },
    models: SYSTEMONE_MODELS,
  };
}

// ---------------------------------------------------------------------------
// 自动发现（界面上的「自动发现」按钮）
// ---------------------------------------------------------------------------

/** 一个地址上 `/v1/systemone` 的探测结论。 */
export type SystemOneProbe =
  /** 路由在，而且认这套协议（空请求体换回一个 422 校验错误）。 */
  | "yes"
  /** 路由在，但这把 Key 不让进（401/403）—— 地址没填错，是权限的事。 */
  | "forbidden"
  /** 这个地址上没有判定端点（404/405）。 */
  | "no"
  /** 没连上，或者回了个看不懂的状态。 */
  | "unknown";

/** 一个候选地址：能不能判定 + 它自己的模型清单。 */
export type SystemOneDiscoveredBase = {
  /** 完整地址，可以直接填进「云端 Base URL」。 */
  base: string;
  systemone: SystemOneProbe;
  models: SystemOneDiscoveredModel[];
  /** 读模型清单时发生了什么（HTTP 状态或错误），读到了就是空串。 */
  note: string;
};

export type SystemOneDiscovery = {
  /** 地址本身连得上（`/v1/models` 有响应，哪怕是 4xx）。 */
  reachable: boolean;
  base: string;
  systemone: SystemOneProbe;
  models: SystemOneModelListing;
  /** 判定服务挂在子路径上时，这里是找到的候选（按证据强弱排序）。 */
  candidates: SystemOneDiscoveredBase[];
  /** 读不到东西时的原因，给界面直接显示。 */
  message: string;
};

/** 站点根（`http://host:38003/jev/laya` → `http://host:38003`）；解析不了就返回空串。 */
function originOf(base: string): string {
  try {
    return new URL(base).origin;
  } catch {
    return "";
  }
}

/** 发现是交互操作：用户在等，超时要短，不跟调用共用那 60 秒。 */
const DISCOVER_TIMEOUT_MS = 12_000;
/** 候选地址逐个探测，多了会把一次点击拖成几十秒。 */
const MAX_CANDIDATES = 6;

async function fetchJson(
  url: string,
  apiKey: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVER_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(init?.headers ?? {}),
      },
      signal: controller.signal,
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body, error: "" };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return { status: 0, body: null, error: aborted ? `超时（${DISCOVER_TIMEOUT_MS} ms）` : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 探一个地址认不认 `/v1/systemone`：故意发一个**空请求体**。
 *
 * 真的判定服务会拿校验错误（422）回绝 —— 那恰好证明路由在、协议对，而且这一下
 * 不会产生任何判定（不花额度）。没有这个路由的服务回 404，网关拦住的回 401/403。
 */
async function probeSystemOne(base: string, apiKey: string): Promise<SystemOneProbe> {
  const { status } = await fetchJson(`${base}/v1/systemone`, apiKey, { method: "POST", body: "{}" });
  if (status === 422 || status === 400) return "yes";
  if (status >= 200 && status < 300) return "yes";
  if (status === 401 || status === 403) return "forbidden";
  if (status === 404 || status === 405) return "no";
  return "unknown";
}

async function listModels(
  base: string,
  apiKey: string,
): Promise<{ listing: SystemOneModelListing; note: string }> {
  const { status, body, error } = await fetchJson(`${base}/v1/models`, apiKey);
  if (error) return { listing: { jev: [], others: [] }, note: error };
  const listing = parseSystemOneModelListing(body);
  if (status < 200 || status >= 300) {
    return { listing, note: `HTTP ${status}` };
  }
  return { listing, note: "" };
}

/**
 * 读一个地址上到底有什么：模型清单 + 判定端点在不在；根路径上没有判定端点时，
 * 再翻一遍 `openapi.json` 找挂在子路径上的判定服务（见
 * `findSystemOnePassthroughBases` 的注释）。
 *
 * 不写任何设置 —— 用户看过发现结果之后自己决定填哪个。
 */
export async function discoverSystemOne(input: { baseUrl: string; apiKey: string }): Promise<SystemOneDiscovery> {
  const base = normalizeBase(input.baseUrl) || DEFAULT_CLOUD_BASE;
  const apiKey = input.apiKey;
  const [{ listing, note }, systemone] = await Promise.all([
    listModels(base, apiKey),
    probeSystemOne(base, apiKey),
  ]);
  const reachable = !note.startsWith("超时") && !note.startsWith("Error") && !note.startsWith("TypeError");
  /*
   * 候选总是找一遍，**哪怕当前地址自己就能判定**。
   *
   * 一台网关上常常挂着好几个判定服务（`/jev/laya`、`/jev/openjev`、`/jev/openjev-27b`），
   * 它们全都自称 `jev-latest` —— 光看模型名分不出现在打的是哪一个，更不知道还有
   * 别的可选。所以把同机的都列出来，界面才有得挑。
   *
   * 翻的是**站点根**的 openapi.json：用户填的地址可能已经是某个子路径，在它下面
   * 是找不到网关自己那份文档的。
   */
  const origin = originOf(base);
  const candidates: SystemOneDiscoveredBase[] = [];
  if (origin) {
    const { body } = await fetchJson(`${origin}/openapi.json`, apiKey);
    const prefixes = findSystemOnePassthroughBases(body).slice(0, MAX_CANDIDATES);
    for (const prefix of prefixes) {
      const candidateBase = `${origin}${prefix}`;
      // 当前用的那一条不用再列一遍（它的模型已经在 models 里）。
      if (candidateBase === base) continue;
      const [probe, models] = await Promise.all([
        probeSystemOne(candidateBase, apiKey),
        listModels(candidateBase, apiKey),
      ]);
      candidates.push({
        base: candidateBase,
        systemone: probe,
        models: [...models.listing.jev, ...models.listing.others],
        note: models.note,
      });
    }
  }
  logEvent({
    level: "info",
    source: "systemone",
    event: "systemone.discover",
    message: `发现 ${base}：判定端点 ${systemone}，模型 ${listing.jev.length + listing.others.length} 个，候选 ${candidates.length} 个`,
    detail: { base, systemone, candidates: candidates.map((c) => ({ base: c.base, systemone: c.systemone })) },
  });
  return { reachable, base, systemone, models: listing, candidates, message: note };
}

// ---------------------------------------------------------------------------
// 调用
// ---------------------------------------------------------------------------

/** 上游返回的 body 是否够格当官方响应（必须有 model / answers / usage）。 */
function coerceResponse(raw: unknown): SystemOneResponse | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.model !== "string") return null;
  if (typeof obj.answers !== "object" || obj.answers === null) return null;
  const usage = obj.usage as Record<string, unknown> | undefined;
  if (typeof usage !== "object" || usage === null) return null;
  return {
    model: obj.model,
    answers: obj.answers as SystemOneResponse["answers"],
    usage: {
      input_tokens: Number(usage.input_tokens ?? 0) || 0,
      output_tokens: Number(usage.output_tokens ?? 0) || 0,
    },
  };
}

type HttpBackend = { base: string; apiKey: string; label: SystemOneBackendKind };

/** 打一个 TypeSafe 兼容的 HTTP 后端（云端官方，或用户自建的本地服务）。 */
async function callHttpBackend(
  target: HttpBackend,
  request: SystemOneRequest,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<SystemOneResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(`${target.base}/v1/systemone`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}),
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      // 上游的错误原样透传：客户端看到的必须是官方的 401 / 422 / 429 形状。
      const message =
        (typeof parsed === "object" && parsed !== null
          ? ((parsed as { detail?: { message?: string } }).detail?.message ?? "")
          : "") || `上游返回 ${res.status}`;
      return {
        ok: false,
        status: res.status,
        body: parsed ?? { detail: { error_type: "api_error", message } },
        message,
        backend: target.label,
      };
    }
    const response = coerceResponse(parsed);
    if (!response) {
      logEvent({
        level: "error",
        source: "systemone",
        event: "systemone.response_invalid",
        message: "上游返回的响应不符合 /v1/systemone 契约",
        detail: { backend: target.label, sample: text.slice(0, 400) },
      });
      return failure(502, "api_error", "上游返回的响应不符合 /v1/systemone 契约", target.label);
    }
    return { ok: true, response, backend: target.label, requestId: "" };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    logEvent({
      level: "error",
      source: "systemone",
      event: "systemone.request_failed",
      message: e instanceof Error ? e.message : String(e),
      detail: { backend: target.label, base: target.base, aborted, error: e },
    });
    return failure(
      aborted ? 504 : 502,
      aborted ? "timeout_error" : "connection_error",
      aborted
        ? `请求 ${target.label === "cloud" ? "云端" : "本地服务"}超时（${timeoutMs} ms）`
        : `无法连接 ${target.base}：${e instanceof Error ? e.message : e}`,
      target.label,
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** 走托管运行时（laya-mlx worker）。 */
async function callLocalRuntime(
  target: { weights: string; version: string },
  request: SystemOneRequest,
): Promise<SystemOneResult> {
  const result = await layaPredict({
    model: target.version,
    weights: target.weights,
    state: request.state,
    questions: request.questions,
  });
  if (!result.ok) {
    logEvent({
      level: "error",
      source: "systemone",
      event: "systemone.local_failed",
      message: result.error,
      detail: { kind: result.kind, weights: target.weights },
    });
    return failure(
      result.kind === "timeout" ? 504 : 502,
      result.kind === "timeout" ? "timeout_error" : "local_runtime_error",
      result.error,
      "local-runtime",
    );
  }
  const response = coerceResponse(result.response);
  if (!response) return failure(502, "api_error", "本地 worker 返回的响应不符合契约", "local-runtime");
  return { ok: true, response, backend: "local-runtime", requestId: "" };
}

/** 按解析出的后端真正发一次请求（`model` 的归一化规则按后端不同，见各自的注释）。 */
async function callBackend(
  backend: SystemOneBackendKind,
  cfg: SystemOneConfig,
  request: SystemOneRequest,
  signal?: AbortSignal,
): Promise<SystemOneResult> {
  if (backend === "cloud") {
    return callHttpBackend(
      { base: cfg.cloudBaseUrl, apiKey: cfg.cloudApiKey, label: "cloud" },
      { ...request, model: resolveCloudModel(request.model, cfg.cloudModel) },
      cfg.timeoutMs,
      signal,
    );
  }
  if (backend === "local-url") {
    // 自建的本地服务：**模型名原样转发**。那是别人自己的服务器，名字由它定义
    // （用户的 laya 服务就叫 jev-latest），我们改名反而会让它认不出来。
    return callHttpBackend(
      { base: cfg.localBaseUrl, apiKey: cfg.localApiKey, label: "local-url" },
      request,
      cfg.timeoutMs,
      signal,
    );
  }
  return callLocalRuntime(resolveLocalRuntimeTarget(request.model, cfg.localModel), request);
}

/**
 * 跑一次 SystemOne。
 *
 * 调用方（Agent 工具 / 面板 / 网关）只需要处理 `SystemOneResult` 两种情况；
 * 校验由调用方先做（网关要回 422，工具要回可读的错误）。
 *
 * `auto` 下多一条**连不上就回落云端**：本地服务配了但没起来（或运行时崩了）时，
 * 安静地失败是这里最糟的表现 —— 用户明明配了能用的云端 Key。只对 502/504 回落，
 * 本地服务正常回的 4xx 不回落（那是请求的问题，换云端只会再错一次还多花钱）。
 */
export async function runSystemOne(
  request: SystemOneRequest,
  opts: { signal?: AbortSignal } = {},
): Promise<SystemOneResult> {
  const cfg = systemOneConfig();
  const backend = await resolveBackend(cfg);
  if (!backend) {
    const hint =
      cfg.backend === "cloud"
        ? "未配置云端 JEV Key（JEV 页左栏「判定引擎」→「云端接入」里的「云端 API Key」）"
        : "没有可用的 JEV 后端：本地运行时未安装，本地服务地址为空，云端 Key 也未配置";
    logEvent({
      level: "warn",
      source: "systemone",
      event: "systemone.no_backend",
      message: hint,
      detail: { backend: cfg.backend },
    });
    return failure(503, "configuration_error", hint, null);
  }

  let result = await callBackend(backend, cfg, request, opts.signal);
  if (!result.ok && worthCloudFallback(cfg, result)) {
    logEvent({
      level: "warn",
      source: "systemone",
      event: "systemone.fallback_cloud",
      message: `本地 JEV 后端不可用（${result.status}），本次改走云端`,
      detail: { from: result.backend, status: result.status, reason: result.message },
    });
    const fallback = await callBackend("cloud", cfg, request, opts.signal);
    if (fallback.ok) result = fallback;
  }

  if (result.ok) recordSystemOneUsage(result, request);
  return result;
}

/**
 * 记一行用量。
 *
 * 价格恒为 0（本地是用户的机器，云端是用户自己的 Key，我们不转售），所以这里只记
 * tokens 与次数：账本回答"用了多少、走的哪条路"，不回答"花了多少钱"。
 * 一次都没消耗（0 tokens）的记录不写 —— 与网关转录的口径一致。
 */
function recordSystemOneUsage(result: SystemOneSuccess, request: SystemOneRequest): void {
  const { usage } = result.response;
  if (usage.input_tokens <= 0 && usage.output_tokens <= 0) return;
  const local = result.backend !== "cloud";
  recordUsageEvent({
    channel: "systemone",
    upstream: local ? "local" : "cloud",
    provider: providerLabelFor(local ? "local" : "cloud"),
    model: result.response.model || request.model,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
  });
}

/** 云端鉴权失败时给调用方用的官方文案（网关按有无 Key 区分 403 / 401）。 */
export function authFailure(kind: "missing" | "invalid"): SystemOneFailure {
  return {
    ok: false,
    status: kind === "missing" ? 403 : 401,
    body: systemOneAuthErrorBody(kind),
    message: kind === "missing" ? "缺少 API Key" : "API Key 无效",
    backend: null,
  };
}
