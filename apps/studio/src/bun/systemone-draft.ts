/**
 * 自然语言 → SystemOne 请求（`state` + `questions`）。
 *
 * 为什么要这一步：JEV 的请求体是**强类型**的（choice / score / noul 各有自己的
 * criteria 形状），第一次打开这一页的人面对一排输入框第一反应是"我该问什么" ——
 * 而他们其实很清楚自己要什么（"帮我按这几条标准给简历打分"）。让当前配置的**聊天模型**
 * 把这句人话翻成请求体，人就只需要写人话；生成结果照常填进编辑器，仍然可以手改。
 *
 * 三条设计约定：
 * - **生成不等于调用**：本模块只产出请求体，跑不跑由调用方决定（界面是"生成并运行"，
 *   但生成失败不该顺带丢一次推理）；
 * - **只允许 JSON**：给模型的契约是"只输出一个 JSON 对象"，并用 `validateSystemOneRequest`
 *   按官方契约校验 —— 省得把结构不对的东西塞进编辑器；
 * - **失败再修一轮**：本地小模型第一遍常把 criteria 写错形状。把校验错误连同它的输出
 *   回喂一次，比直接报错好用得多（也只回喂一次，避免和模型来回拉扯）。
 */
import { generateText } from "ai";

import { logEvent } from "./app-log";
import { getChatModel, getChatModelLabel } from "./chat-model";
import { recordUsage } from "./stats";
import { SYSTEMONE_DEFAULT_MODEL, validateSystemOneRequest, type SystemOneQuestions } from "../shared/systemone";

export type SystemOneDraft =
  | { ok: true; state: string; questions: SystemOneQuestions; modelUsed: string }
  | { ok: false; error: string };

const SYSTEM_PROMPT = `你是把自然语言需求翻译成 TypeSafe SystemOne 请求体的助手。

输出契约（**只输出一个 JSON 对象，不要解释、不要 Markdown 代码块**）：
{"state": <要判断的内容>, "questions": {"<问题名>": {"type": ..., "instructions": ..., "criteria": ...}}}

三种问题类型（必须严格按形状写）：
1. noul —— 是/否。
   {"type":"noul","instructions":"……吗？","criteria":{"true":"什么算 yes","false":"什么算 no"}}
   criteria 可省略，但边界模糊时一定要写。
2. choice —— 在若干**无序**选项里选一个。criteria 是「选项名 → 什么情况下选它」的映射。
   {"type":"choice","instructions":"……","criteria":{"billing":"发票、退款相关","technical":"Bug、故障"}}
3. score —— 在**有序**档位上打分。criteria 是**从低到高的数组**，下标就是档位号（从 0 起）。
   {"type":"score","instructions":"……","criteria":["不影响功能","烦人但不阻塞","阻塞客户工作"]}

写问题时的硬规矩：
- 一个维度一个问题。不要在一个问题里同时问"紧不紧急"和"归哪个团队"。
- 档位/选项要写**具体情形**，不要写"低/中/高"这种程度词。
- instructions 是给模型看的问句本身；问题名只是回执键，模型看不到它，所以不要把关键信息放在问题名里。
- 问题名用英文 snake_case（如 department / urgency / refund_requested）。
- 一次可以给多个问题：同一份 state 上并行评估、互不影响。
- state 是要被判断的**原始内容**（原文照抄或整理成清晰文本），不要把问题混进 state。
- 对方给的内容不足以判断某项时，就别生成那个问题，而不是编一个。

如果对方只给了零散要点，你要自己补齐成一个完整、可直接执行的请求。`;

/** 从模型输出里抠出第一个完整的 JSON 对象（允许外面包着解释文字或代码块）。 */
export function extractJsonObject(text: string): unknown | null {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 把模型输出按官方契约校验一遍，取出 state 与 questions。 */
function readDraft(raw: unknown): { state: string; questions: SystemOneQuestions } | { error: string } {
  if (typeof raw !== "object" || raw === null) return { error: "模型返回的不是 JSON 对象" };
  const obj = raw as Record<string, unknown>;
  // model 由服务端定（默认别名），这里只认 state / questions 两件事。
  const validated = validateSystemOneRequest({
    state: obj.state,
    model: SYSTEMONE_DEFAULT_MODEL,
    questions: obj.questions,
  });
  if (!validated.ok) {
    const detail = validated.errors.map((e) => `${e.loc.join(".")}: ${e.msg}`).join("; ");
    return { error: detail };
  }
  return { state: validated.value.state as string, questions: validated.value.questions };
}

/**
 * 把一句自然语言（可附上要判断的原文）翻译成 SystemOne 请求体。
 *
 * `instruction` 是界面上的那句话；`text` 是用户贴进来的内容（可选，有就原样作为 state 的
 * 素材）。两者都空时报错，不浪费一次推理。
 */
export async function draftSystemOneRequest(input: { instruction: string; text?: string }): Promise<SystemOneDraft> {
  const instruction = (input.instruction ?? "").trim();
  const supplied = (input.text ?? "").trim();
  if (!instruction && !supplied) return { ok: false, error: "先说一句你要判断什么（或把内容贴进来）" };

  const userPrompt = [
    supplied ? `要判断的内容（可以作为 state 的素材，原文照抄或整理清楚）：\n"""\n${supplied}\n"""` : "",
    instruction ? `要求：${instruction}` : "",
    "只输出那个 JSON 对象。",
  ]
    .filter(Boolean)
    .join("\n\n");

  const model = getChatModel();
  const modelLabel = getChatModelLabel();
  try {
    let result = await generateText({
      model,
      system: SYSTEM_PROMPT,
      prompt: userPrompt,
      // 结构化翻译要稳、不要创意。
      temperature: 0.2,
      maxOutputTokens: 2000,
    });
    recordUsage(modelLabel, result.usage?.inputTokens ?? 0, result.usage?.outputTokens ?? 0);

    let raw = extractJsonObject(result.text ?? "");
    let parsed = raw === null ? { error: "模型没有返回 JSON" } : readDraft(raw);
    if ("error" in parsed) {
      // 回喂一次：把小模型的常见错法（criteria 写成字符串、score 档位倒序…）纠回来。
      logEvent({
        source: "systemone",
        event: "systemone.draft.repair",
        message: `生成的请求不合契约，回喂一次：${parsed.error}`,
        detail: { error: parsed.error, model: modelLabel },
      });
      result = await generateText({
        model,
        system: SYSTEM_PROMPT,
        prompt: [
          userPrompt,
          `上一次的输出是这样的（不合契约）：\n${(result.text ?? "").slice(0, 1500)}`,
          `校验失败的原因：${parsed.error}`,
          "请修正后只输出那个 JSON 对象。",
        ].join("\n\n"),
        temperature: 0.1,
        maxOutputTokens: 2000,
      });
      recordUsage(modelLabel, result.usage?.inputTokens ?? 0, result.usage?.outputTokens ?? 0);
      raw = extractJsonObject(result.text ?? "");
      parsed = raw === null ? { error: "模型没有返回 JSON" } : readDraft(raw);
    }
    if ("error" in parsed) {
      logEvent({
        level: "warn",
        source: "systemone",
        event: "systemone.draft.failed",
        message: parsed.error,
        detail: { model: modelLabel, instruction: instruction.slice(0, 200) },
      });
      return { ok: false, error: `没能生成合法的请求体：${parsed.error}` };
    }
    return { ok: true, state: parsed.state, questions: parsed.questions, modelUsed: modelLabel };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logEvent({
      level: "error",
      source: "systemone",
      event: "systemone.draft.error",
      message,
      detail: { model: modelLabel, error: e },
    });
    return { ok: false, error: `生成失败：${message}` };
  }
}
