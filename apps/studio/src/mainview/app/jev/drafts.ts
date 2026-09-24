/**
 * JEV 页的纯逻辑：问题草稿 ↔ 官方请求形状、以及调用示例的生成。
 *
 * 单独一个文件是为了能直接单测：`buildQuestions` 决定了"界面上填的东西"变成
 * 什么样的请求体，而它出错的样子是"面板能跑、网关 422"这种很难一眼看出的偏差。
 */
import type { SystemOneQuestion } from "../../../shared/systemone";

export type SystemOneQuestionTypeName = "noul" | "choice" | "score";

/** 界面上正在编辑的一个问题（比请求体宽松：允许半填状态）。 */
export type QuestionDraft = {
  /** 本地稳定 id（列表 key / 定位用），与请求里的问题名无关。 */
  id: string;
  /** 问题名：会原样出现在响应的 answers 里。 */
  name: string;
  type: SystemOneQuestionTypeName;
  instructions: string;
  /** noul：什么算 yes / no（都可留空）。 */
  trueDesc: string;
  falseDesc: string;
  /** choice：选项标签 → 适用情形。 */
  options: { label: string; desc: string }[];
  /** score：有序档位（从低到高），下标即档位号。 */
  levels: string[];
};

/**
 * 官方请求体的问题 → 编辑器草稿（「用一句话生成请求」拿到结果后回填用）。
 *
 * 与 `buildQuestions` 是**反方向**：那个把界面上填的东西变成请求体，这个把请求体摊成
 * 可编辑的字段。两者必须能来回（生成 → 编辑 → 再生成请求体不会丢东西），所以
 * criteria 的三种形状在这里一一还原成对应的编辑控件。
 */
export function draftFromQuestions(questions: Record<string, unknown>): QuestionDraft[] {
  return Object.entries(questions).map(([name, raw], index) => {
    const question = (raw ?? {}) as { type?: string; instructions?: unknown; criteria?: unknown };
    const draft = newQuestionDraft(name, (question.type as SystemOneQuestionTypeName) ?? "noul");
    draft.id = `draft-${index}-${name}`;
    draft.instructions = typeof question.instructions === "string" ? question.instructions : "";
    if (draft.type === "choice") {
      const criteria = (question.criteria ?? {}) as Record<string, unknown>;
      const options = Object.entries(criteria).map(([label, desc]) => ({
        label,
        desc: typeof desc === "string" ? desc : desc === null || desc === undefined ? "" : JSON.stringify(desc),
      }));
      // 模型没给 criteria（或给了空对象）时留一行空的，让用户能接着填，而不是空列表。
      draft.options = options.length > 0 ? options : [{ label: "", desc: "" }];
    } else if (draft.type === "score") {
      const criteria = Array.isArray(question.criteria) ? question.criteria : [];
      draft.levels = criteria.map((level) =>
        typeof level === "string" ? level : level === null || level === undefined ? "" : JSON.stringify(level),
      );
    } else {
      const criteria = (question.criteria ?? {}) as Record<string, unknown>;
      for (const key of ["true", "false"] as const) {
        const value = criteria[key];
        if (typeof value === "string") {
          if (key === "true") draft.trueDesc = value;
          else draft.falseDesc = value;
        }
      }
    }
    return draft;
  });
}

/** 新问题的骨架：按原语给出该类型最常用的 criteria 形状，用户改文字即可。 */
export function newQuestionDraft(name: string, type: SystemOneQuestionTypeName): QuestionDraft {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    type,
    instructions: "",
    trueDesc: "",
    falseDesc: "",
    options:
      type === "choice"
        ? [
            { label: "option_a", desc: "" },
            { label: "option_b", desc: "" },
          ]
        : [],
    levels: type === "score" ? ["", "", ""] : [],
  };
}

export function uniqueQuestionName(drafts: QuestionDraft[], type: SystemOneQuestionTypeName): string {
  const base = type === "noul" ? "question" : type === "choice" ? "category" : "rating";
  const taken = new Set(drafts.map((draft) => draft.name.trim()));
  let index = drafts.length + 1;
  let name = `${base}_${index}`;
  while (taken.has(name)) name = `${base}_${++index}`;
  return name;
}

/** 校验失败的原因，交给界面翻成文案（这里只给机器可读的 code）。 */
export type DraftProblem = { kind: "empty-name"; index: number } | { kind: "duplicate"; name: string };

/**
 * 草稿 → 官方请求形状的 `questions`。
 *
 * 两条约定：
 * - 空字段**不发送**（官方这几个字段本来就是可选的，送空串等于替用户改语义）；
 * - 重复 / 空的问题名在这里就报出来，而不是等网关回 422 —— 用户看得见是哪一个框。
 */
export function buildQuestions(drafts: QuestionDraft[]): {
  questions: Record<string, SystemOneQuestion>;
  problems: DraftProblem[];
} {
  const questions: Record<string, SystemOneQuestion> = {};
  const problems: DraftProblem[] = [];
  drafts.forEach((draft, index) => {
    const name = draft.name.trim();
    if (!name) {
      problems.push({ kind: "empty-name", index });
      return;
    }
    if (questions[name]) {
      problems.push({ kind: "duplicate", name });
      return;
    }
    const instructions = draft.instructions.trim();
    if (draft.type === "noul") {
      const criteria: { true?: string; false?: string } = {};
      if (draft.trueDesc.trim()) criteria.true = draft.trueDesc.trim();
      if (draft.falseDesc.trim()) criteria.false = draft.falseDesc.trim();
      questions[name] = {
        type: "noul",
        ...(instructions ? { instructions } : {}),
        ...(Object.keys(criteria).length > 0 ? { criteria } : {}),
      };
      return;
    }
    if (draft.type === "choice") {
      const criteria: Record<string, string | null> = {};
      for (const option of draft.options) {
        const label = option.label.trim();
        if (label) criteria[label] = option.desc.trim() || null;
      }
      questions[name] = { type: "choice", ...(instructions ? { instructions } : {}), criteria };
      return;
    }
    questions[name] = {
      type: "score",
      ...(instructions ? { instructions } : {}),
      criteria: draft.levels.map((level) => level.trim()).filter(Boolean),
    };
  });
  return { questions, problems };
}

/**
 * 一段可复制的调用示例（cURL + Python + JS + 直连网关的两行环境变量）。
 *
 * 存在的理由：官方 SDK 只要换两行环境变量就能打到本机网关，但"两行"具体是哪两行、
 * 路径长什么样，用户不该靠猜。示例里的 Key 用占位符而不是真值 —— 面板读不到明文
 * （远程读设置会抹掉密钥），也不该把密钥写进剪贴板。
 */
export function buildCallExample(
  state: string,
  questions: Record<string, SystemOneQuestion>,
  gatewayBase = "http://127.0.0.1:<网关端口>",
): string {
  const payload = JSON.stringify({ state, model: "jev-latest", questions }, null, 2);
  return `# 官方 SDK 只改这两行就能打到本机网关（设置 → 网关里能看到端口与 Key）
#   TYPESAFE_BASE_URL=${gatewayBase}
#   TYPESAFE_API_KEY=<设置 → 网关 → API Key>

# cURL
curl -s ${gatewayBase}/v1/systemone \\
  -H "Authorization: Bearer $OMNI_GATEWAY_KEY" \\
  -H "Content-Type: application/json" \\
  -d '${payload.replace(/\n/g, "\n  ")}'

# Python（pip install typesafe-sdk）
import os
from typesafe_sdk import TypeSafeClient

os.environ["TYPESAFE_BASE_URL"] = "${gatewayBase}"
os.environ["TYPESAFE_API_KEY"] = "<设置 → 网关 → API Key>"

with TypeSafeClient() as client:
    response = client.system_one(state=STATE, questions=QUESTIONS)
    print(response.answers)

# JavaScript（npm i @typesafe-ai/sdk）
import { TypeSafeClient } from "@typesafe-ai/sdk";

process.env.TYPESAFE_BASE_URL = "${gatewayBase}";
process.env.TYPESAFE_API_KEY = "<设置 → 网关 → API Key>";

const client = new TypeSafeClient();
const response = await client.systemOne({ state: STATE, questions: QUESTIONS });

// STATE / QUESTIONS 就是上面那一份：
const STATE = ${JSON.stringify(state)};
const QUESTIONS = ${JSON.stringify(questions, null, 2)};`;
}
