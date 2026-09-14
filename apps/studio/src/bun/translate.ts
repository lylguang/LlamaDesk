import { eq, desc } from "drizzle-orm";
import { db } from "./db";
import { translationRecords } from "./db/schema";
import { getSetting } from "./db/settings";
import { getChatModelLabel, getChatRequestModelId } from "./chat-model";
import { ensureServerReady, getChatBaseUrl, maxOutputTokens } from "./chat";
import { recordUsage } from "./stats";
import { currentUpstream, providerLabelFor, recordUsageEvent } from "./usage";
import { estimateTokens } from "../shared/token-estimate";
import { translationLangLabel } from "../shared/translate";

export type TranslationRecordRow = {
  id: number;
  sourceLang: string;
  targetLang: string;
  text: string;
  result: string | null;
  model: string | null;
  createdAt: number;
};

/** 谷歌「浏览器同款」免费翻译接口（gtx）。走代理与否由全局设置决定（见 bun/proxy.ts）。 */
async function googleTranslate(
  text: string,
  sourceLang: string,
  targetLang: string,
): Promise<string> {
  const body = new URLSearchParams({
    client: "gtx",
    sl: sourceLang === "auto" ? "auto" : sourceLang,
    tl: targetLang,
    dt: "t",
    q: text,
  });
  const res = await fetch("https://translate.googleapis.com/translate_a/single", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`谷歌翻译请求失败 (HTTP ${res.status})`);
  const raw = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    // 个别响应里会出现字面量 undefined（非合法 JSON），替换后再解析
    data = JSON.parse(raw.replace(/\bundefined\b/g, "null"));
  }
  const segments = (Array.isArray(data) ? (data as unknown[])[0] : undefined) as
    | unknown[]
    | undefined;
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error("谷歌翻译响应格式异常");
  }
  const out = segments
    .map((s) => (Array.isArray(s) ? String(s[0] ?? "") : ""))
    .join("");
  if (!out.trim()) throw new Error("谷歌翻译未返回译文");
  return out;
}

/**
 * 翻译一段文本，返回译文并把结果写入历史记录。
 * engine 为 "model" 时走当前对话模型（本地推理服务器 / OpenAI 兼容 API，
 * 模型与服务器配置完全复用聊天，本地模式下服务器未就绪会自动启动并等待）；
 * engine 为 "google" 时走谷歌浏览器同款免费接口，不依赖本地模型。
 */
export async function runTranslation(params: {
  text: string;
  sourceLang?: string;
  targetLang: string;
  engine?: "model" | "google";
  /** false 时仅翻译不入库（同传等高频场景，避免刷爆历史记录）。 */
  save?: boolean;
}): Promise<{ text?: string; id?: number; error?: string }> {
  const text = (params.text ?? "").trim();
  if (!text) return { error: "待翻译文本不能为空" };
  if (!params.targetLang) return { error: "未指定目标语言" };

  if (params.engine === "google") {
    try {
      const content = await googleTranslate(
        text,
        params.sourceLang ?? "auto",
        params.targetLang,
      );
      if (params.save === false) return { text: content };
      const record = db
        .insert(translationRecords)
        .values({
          sourceLang: params.sourceLang ?? "auto",
          targetLang: params.targetLang,
          text,
          result: content,
          model: "Google Translate",
        })
        .returning()
        .get();
      return { text: content, id: record.id };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  // 请求里填本地服务器认的 id（MLX 是绝对路径）；记录与展示仍用服务名。
  const model = getChatRequestModelId();
  const modelLabel = getChatModelLabel() || model;
  const base = getChatBaseUrl();
  if (!model || !base) {
    return { error: !model ? "未配置模型" : "未配置推理服务器" };
  }

  if (getSetting("SERVER_MODE") === "local") {
    const ready = await ensureServerReady();
    if (!ready.ok) return { error: ready.error || "推理服务器未就绪" };
  }

  const sourceLabel =
    params.sourceLang && params.sourceLang !== "auto"
      ? translationLangLabel(params.sourceLang)
      : "自动检测";
  const targetLabel = translationLangLabel(params.targetLang);

  const instruction =
    `你是专业的翻译引擎。请把下面的内容从「${sourceLabel}」翻译成「${targetLabel}」。` +
    `只输出译文本身，不要输出任何解释、注释或原文。` +
    `遇到代码、专有名词、人名地名或无法翻译的内容时，请原样保留。`;

  const apiKey = getSetting("VLLM_API_KEY");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey && apiKey !== "EMPTY") headers.Authorization = `Bearer ${apiKey}`;

  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: instruction },
          { role: "user", content: text },
        ],
        // 译文长度与原文同量级；显式给上限，免得 mlx-lm 默认的 512 被推理模型的思考吃光。
        max_tokens: maxOutputTokens(),
        // 流式接收（本函数内就地聚合）：慢模型逐 token 有数据流动，不会触发传输层
        // 的静默/整体超时；总时长仍由下面的 AbortSignal 封顶。
        stream: true,
      }),
      // Bun fetch 默认 300s 就掐断整个请求（非空闲超时），慢模型的长译文必然被杀；
      // 关掉它，只认上面 600s 的显式上限。timeout 是 Bun 扩展字段，标准 RequestInit 没有。
      timeout: false,
      signal: AbortSignal.timeout(600_000),
    } as RequestInit);

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const msg = body
        ? (() => {
            try {
              return JSON.parse(body)?.error?.message ?? body.slice(0, 300);
            } catch {
              return body.slice(0, 300);
            }
          })()
        : `HTTP ${res.status}`;
      return { error: msg };
    }

    if (!res.body) return { error: "模型响应为空" };

    // SSE 就地聚合：攒完整译文后再一次性入库 / 返回（UI 仍是转圈等结果，不变）。
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let raw = "";
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;

    const consumeLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const payloadLine = trimmed.slice(5).trim();
      if (payloadLine === "[DONE]") return;
      try {
        const json = JSON.parse(payloadLine) as {
          choices?: { delta?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const delta = json.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) raw += delta;
        if (json.usage) usage = json.usage;
      } catch {
        // skip malformed chunk
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        consumeLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    }
    if (buffer.trim()) consumeLine(buffer);

    recordUsage(modelLabel, usage?.prompt_tokens ?? 0, usage?.completion_tokens ?? 0);

    // 推理模型可能把思考草稿塞进 content：剥掉成对 / 未闭合的 <think> 段与残留标签。
    const content = raw
      .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "")
      .replace(/^\s*<\/think>/i, "")
      .trim();
    // 整段翻译（长文档尤其）是实打实的一次调用，一样进用量账本。上游没回 usage
    // 时按送出去的提示与回来的译文估算，来源如实标注。
    const upstream = currentUpstream();
    recordUsageEvent({
      channel: "translate",
      upstream,
      provider: providerLabelFor(upstream),
      model: modelLabel,
      inputTokens: usage?.prompt_tokens ?? estimateTokens(instruction + text),
      outputTokens: usage?.completion_tokens ?? estimateTokens(content),
      estimated: usage == null,
    });
    if (!content) {
      return { error: "模型未返回译文（可能思考内容占满了输出上限），请重试或更换更小的模型" };
    }

    if (params.save === false) return { text: content };
    const record = db
      .insert(translationRecords)
      .values({
        sourceLang: params.sourceLang ?? "auto",
        targetLang: params.targetLang,
        text,
        result: content,
        model: modelLabel,
      })
      .returning()
      .get();

    return { text: content, id: record.id };
  } catch (e) {
    return { error: friendlyTranslateError(e) };
  }
}

/** 把底层超时 / 中断异常转成可行动的中文提示（原始报错对用户没有意义）。 */
function friendlyTranslateError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/timed?\s*out|timeout/i.test(msg)) {
    return "翻译超时：模型响应过慢（推理模型可能一直在思考）。可重试一次、换更小的模型，或把翻译引擎切到「Google 翻译」。";
  }
  if (/abort/i.test(msg)) {
    return "翻译请求被中断，请重试。";
  }
  if (/fetch failed|econnrefused|connect|network/i.test(msg)) {
    return "无法连接推理服务器：请确认本地模型已启动，或检查网络与代理设置。";
  }
  return msg;
}

export function listTranslationRecords(limit = 100): TranslationRecordRow[] {
  return db
    .select()
    .from(translationRecords)
    .orderBy(desc(translationRecords.createdAt))
    .limit(limit)
    .all()
    .map((r) => ({ ...r, createdAt: r.createdAt ?? 0 }));
}

export function deleteTranslationRecord(id: number): { ok: boolean } {
  db.delete(translationRecords).where(eq(translationRecords.id, id)).run();
  return { ok: true };
}
