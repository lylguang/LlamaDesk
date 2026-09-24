import { getSetting, updateSettings } from "./db/settings";
import * as CloudProviders from "./cloud-providers";
import { normalizeApiBase } from "../shared/cloud-providers";
import {
  OMNI_CALL_AUDIO_FORMAT,
  VOICE_CALL_OMNI_DEFAULT_MODEL,
} from "../shared/voice-call-omni";
import { logEvent } from "./app-log";
import { recordUsageEvent } from "./usage";

/**
 * 通话模式的 omni 后端：把整段用户音频直接发给 OpenAI 兼容的 Chat Completions
 * （`qwen3.8-omni-flash` 这类多模态模型，音频进、文字出），流式收正文。
 *
 * 与 `realtime-voice.ts` 的分工：那边是 WebSocket 全双工（服务端 VAD、服务端出声），
 * 这边是**一次请求一段音频**的请求-响应模型 —— 断句仍由前端能量 VAD 负责，出声仍走
 * 原来的逐句 TTS。所以这里只做三件事：拼请求、解 SSE、报错留有痕迹。
 *
 * 请求形状（对照 docs.qwencloud.com 的 OpenAI 兼容示例与百炼 qwen-omni 文档）：
 *   POST {base}/chat/completions
 *   { model, messages:[…, {role:"user", content:[
 *       {type:"input_audio", input_audio:{data:"data:;base64,<wav>", format:"wav"}},
 *       {type:"text", text:"…"}]}],
 *     modalities:["text"], stream:true, stream_options:{include_usage:true} }
 *
 * 三个容易踩的点：
 *  1. `data` 走 data URI（`data:;base64,` 后直接接 base64，**不带** media type），
 *     容器格式另由 `format` 字段声明；而这些模型只出文字，`modalities` 必须是
 *     `["text"]`（官方文档原话："Do not set audio"）。
 *  2. 音频是整段发的：模型没有服务端 VAD，不能像实时接口那样边推边听。
 *  3. 中转地址不一定带版本段（`/v1` 或 `/api/paas/v4`），所以拼路径统一走
 *     `normalizeApiBase`，不写死 `${base}/v1/chat/completions`。
 */

export type OmniCallConfig = {
  /** 选中的云厂商（API Key 与 Base URL 都取自它）；空 = 未配置。 */
  providerId: string;
  /** 厂商展示名，错误提示里用来指名道姓。 */
  providerName: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 云端是否已配好（选了厂商且密钥非空）。 */
  configured: boolean;
};

/**
 * omni 模式的配置。密钥与地址不单独存设置项，直接取厂商行 —— 与生图 / TTS / 实时语音
 * 同一套（用户在「设置 → 云端模型」里填过一次，各功能页不再问第二遍）。
 */
export function getOmniCallConfig(): OmniCallConfig {
  const providerId = (getSetting("VOICE_CALL_OMNI_PROVIDER_ID") || "").trim();
  const provider = CloudProviders.resolveCloudProvider(providerId);
  const model = (getSetting("VOICE_CALL_OMNI_MODEL") || "").trim() || VOICE_CALL_OMNI_DEFAULT_MODEL;
  return {
    providerId,
    providerName: provider?.name ?? "",
    apiKey: provider?.apiKey.trim() ?? "",
    baseUrl: provider?.baseUrl.trim() ?? "",
    model,
    configured: !!provider && !!provider.apiKey.trim() && !!provider.baseUrl.trim(),
  };
}

export function saveOmniCallConfig(cfg: { providerId?: string; model?: string }): void {
  const settings: Record<string, string> = {};
  if (cfg.providerId !== undefined) settings.VOICE_CALL_OMNI_PROVIDER_ID = cfg.providerId.trim();
  if (cfg.model !== undefined) settings.VOICE_CALL_OMNI_MODEL = cfg.model.trim();
  updateSettings(settings);
}

/** 未配置时的统一提示（startVoiceCall 与测试连接共用，措辞指向真正要改的那一页）。 */
export const OMNI_NOT_CONFIGURED =
  "omni 模式未选择云厂商或未填 API Key，请在通话界面「omni 配置」中选一个已启用密钥的厂商";

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

/** 每次调用请求体里的固定形状。 */
type OmniMessage = {
  role: "system" | "user" | "assistant";
  content:
    | string
    | Array<
        | { type: "input_audio"; input_audio: { data: string; format: string } }
        | { type: "text"; text: string }
      >;
};

/**
 * 音频那一轮附带的文字指令。
 *
 * 不能只发音频：`input_audio` 是"这段音频"这个事实，模型还需要知道要拿它干什么
 * （官方示例也是音频 + 一句问题配对出现的）。也不要把 ASR 转写塞进来说"用户说：…"——
 * 那样模型会去读文字而不是听原声，omni 模式省掉 ASR 的意义就没了。
 */
const AUDIO_TURN_INSTRUCTION = "请直接听上面对话中的这段语音并作答。";

type OmniUsage = { prompt_tokens?: number; completion_tokens?: number };

/**
 * 读 OpenAI 兼容的 SSE 流，逐段回调正文。
 *
 * 单独成一个函数（而不是塞在请求的 closure 里）有两个原因：正文与 usage 都要带出
 * 请求体，靠闭包里的 `let` 会让 TS 的控制流分析把它一路窄化成 `never`；而且解析器
 * 可以脱离网络单测（见 omni-call.test.ts）。
 */
export async function readChatCompletionStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: string) => void,
): Promise<{ text: string; usage: OmniUsage | null }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let usage: OmniUsage | null = null;
  const consume = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let json: { choices?: { delta?: { content?: string } }[]; usage?: OmniUsage };
    try {
      json = JSON.parse(payload);
    } catch {
      // 半截 JSON / keep-alive 注释：跳过这一行即可，不影响后面的正文
      return;
    }
    const delta = json.choices?.[0]?.delta?.content ?? "";
    if (delta) {
      text += delta;
      onDelta(delta);
    }
    if (json.usage) usage = json.usage;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      consume(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  if (buffer.trim()) consume(buffer);
  return { text, usage };
}

export type OmniStreamResult = {
  ok: boolean;
  text: string;
  error?: string;
  /** 被抢话 / 挂断打断（不是失败，正文可能是半句）。 */
  aborted?: boolean;
};

/**
 * 把一段音频发给 omni 模型，流式取回正文。
 *
 * `onDelta` 每收到一段正文调用一次（调用方据此切句朗读）；返回时 `text` 是本轮全文
 * （即使中途被打断，也带着已经收到的部分）。
 */
export async function streamOmniCall(opts: {
  wavBase64: string;
  instructions: string;
  history: { role: "user" | "assistant"; content: string }[];
  onDelta: (delta: string) => void;
  signal?: AbortSignal;
}): Promise<OmniStreamResult> {
  const cfg = getOmniCallConfig();
  if (!cfg.configured) return { ok: false, text: "", error: OMNI_NOT_CONFIGURED };
  if (!opts.wavBase64) return { ok: false, text: "", error: "这段语音没有采到音频" };

  const url = `${normalizeApiBase(cfg.baseUrl)}/chat/completions`;
  const messages: OmniMessage[] = [
    { role: "system", content: opts.instructions },
    ...opts.history.map((m): OmniMessage => ({ role: m.role, content: m.content })),
    {
      role: "user",
      content: [
        {
          type: "input_audio",
          input_audio: {
            data: `data:;base64,${opts.wavBase64}`,
            format: OMNI_CALL_AUDIO_FORMAT,
          },
        },
        { type: "text", text: AUDIO_TURN_INSTRUCTION },
      ],
    },
  ];
  const body = {
    model: cfg.model,
    messages,
    // 这些模型只出文字（设了 audio 会被上游拒），播报由本地的逐句 TTS 负责。
    modalities: ["text"],
    stream: true,
    stream_options: { include_usage: true },
  };

  const abort = new AbortController();
  const signal = opts.signal
    ? AbortSignal.any([abort.signal, opts.signal, AbortSignal.timeout(120_000)])
    : AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      throw new Error(readErrorMessage(raw) ?? `HTTP ${res.status}`);
    }
    if (!res.body) throw new Error("上游没有返回数据流");

    const { text, usage } = await readChatCompletionStream(res.body, opts.onDelta);
    if (usage || text) {
      recordUsageEvent({
        channel: "chat",
        upstream: "cloud",
        provider: cfg.providerName || cfg.baseUrl,
        model: cfg.model,
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
      });
    }
    return { ok: true, text };
  } catch (e) {
    // 抢话 / 挂断打断：不算失败（调用方照常播完已拿到的正文）。
    // 注意这里没法带上半截正文 —— 解析在另一个函数里，它的返回值随异常一起丢了；
    // 已经回调出去的增量早已进了朗读队列，所以听感上仍然是"念到哪算哪"。
    if (opts.signal?.aborted) return { ok: true, text: "", aborted: true };
    const message = e instanceof Error ? e.message : String(e);
    logEvent({
      level: "error",
      source: "tts",
      event: "voicecall.omni_failed",
      message: `omni 通话请求失败：${message}`,
      detail: { model: cfg.model, baseUrl: cfg.baseUrl, providerId: cfg.providerId },
    });
    return { ok: false, text: "", error: message };
  } finally {
    abort.abort();
  }
}

/** 从上游错误响应里抠出人能读的那句（各家包装层数不一，逐层退）。 */
function readErrorMessage(raw: string): string | null {
  const body = raw.trim();
  if (!body) return null;
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    const err = json.error;
    if (typeof err === "string") return err;
    if (err && typeof err === "object") {
      const m = (err as { message?: unknown }).message;
      if (typeof m === "string") return m;
    }
    if (typeof json.message === "string") return json.message;
  } catch {
    // 不是 JSON：退回原文
  }
  return body.slice(0, 300);
}

// ---------------------------------------------------------------------------
// 连接测试（omni 配置面板的「保存并测试」）
// ---------------------------------------------------------------------------

/** 用当前（或给定）配置发一次最小请求，验证密钥 / 地址 / 模型 id 是否可用。 */
export async function testOmniCallConnection(cfg?: {
  providerId?: string;
  model?: string;
}): Promise<{ ok: boolean; error?: string; latencyMs?: number }> {
  const current = getOmniCallConfig();
  // 面板上的选择可能是"刚改还没保存"，所以允许覆盖；密钥仍按 providerId 现取。
  const providerId = (cfg?.providerId ?? current.providerId).trim();
  const provider = CloudProviders.resolveCloudProvider(providerId);
  const model = (cfg?.model ?? current.model).trim() || VOICE_CALL_OMNI_DEFAULT_MODEL;
  const apiKey = provider?.apiKey.trim() ?? "";
  const baseUrl = provider?.baseUrl.trim() ?? "";
  if (!provider) {
    return { ok: false, error: "请先在「设置 → 云端模型」里选择一个厂商并启用" };
  }
  if (!apiKey) {
    return { ok: false, error: `「${provider.name}」还没有填 API Key（设置 → 云端模型）` };
  }
  if (!baseUrl) return { ok: false, error: `「${provider.name}」没有配置 Base URL` };

  const t0 = Date.now();
  try {
    const res = await fetch(`${normalizeApiBase(baseUrl)}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      // 文字 ping 就够了：要验证的是"这个 key + 这个模型 id 能不能用"，
      // 音频那条路只在真打通话时才走（省一次上传，也避免测试本身被音频格式挑刺）。
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        modalities: ["text"],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const latencyMs = Date.now() - t0;
    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      return { ok: false, error: readErrorMessage(raw) ?? `HTTP ${res.status}`, latencyMs };
    }
    return { ok: true, latencyMs };
  } catch (e) {
    return {
      ok: false,
      error: `连接失败：${e instanceof Error ? e.message : String(e)}`,
      latencyMs: Date.now() - t0,
    };
  }
}
