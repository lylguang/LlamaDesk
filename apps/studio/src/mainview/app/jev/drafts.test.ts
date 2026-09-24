/**
 * JEV 页纯逻辑的测试。
 *
 * 守的是"界面上填的东西"到"官方请求体"的翻译：这一步错了的表现很难看出来 ——
 * 页面能跑、网关却回 422，或者某个字段被悄悄送成空串（等于替用户改了语义）。
 */
import { describe, expect, test } from "bun:test";

import { buildCallExample, buildQuestions, draftFromQuestions, newQuestionDraft, uniqueQuestionName } from "./drafts";
import { jevExamples } from "./examples";

describe("草稿 → 请求体", () => {
  test("打开页面装载的第一个示例能直接跑，三种原语各一个", () => {
    const { questions, problems } = buildQuestions(jevExamples("zh")[0]!.questions);
    expect(problems).toEqual([]);
    // 工单分派示例：choice 选团队 + score 判紧急度 + noul 问是否转人工。
    expect(Object.keys(questions)).toEqual(["department", "urgency", "needs_human"]);
    expect(questions.department?.type).toBe("choice");
    expect(questions.urgency?.type).toBe("score");
    expect(questions.needs_human?.type).toBe("noul");
  });

  test("choice：criteria 是「标签 → 描述」映射，空描述送 null（不是空串）", () => {
    const draft = newQuestionDraft("pick", "choice");
    draft.options = [
      { label: "a", desc: "第一个" },
      { label: "b", desc: "" },
      { label: "", desc: "没有标签的整行丢掉" },
    ];
    const { questions } = buildQuestions([draft]);
    expect(questions.pick).toEqual({ type: "choice", criteria: { a: "第一个", b: null } });
  });

  test("score：档位数组保序，空档位丢掉", () => {
    const draft = newQuestionDraft("rate", "score");
    draft.levels = ["低", "", "高"];
    const { questions } = buildQuestions([draft]);
    expect(questions.rate).toEqual({ type: "score", criteria: ["低", "高"] });
  });

  test("noul：没有 true/false 描述时 criteria 整个不发送", () => {
    const draft = newQuestionDraft("ask", "noul");
    expect(buildQuestions([draft]).questions.ask).toEqual({ type: "noul" });
    draft.trueDesc = "算 yes 的情况";
    expect(buildQuestions([draft]).questions.ask).toEqual({ type: "noul", criteria: { true: "算 yes 的情况" } });
  });

  test("instructions 留空时不发送（官方字段本身可选，空串等于改了语义）", () => {
    const draft = newQuestionDraft("ask", "noul");
    expect(buildQuestions([draft]).questions.ask).not.toHaveProperty("instructions");
    draft.instructions = "   " ;
    expect(buildQuestions([draft]).questions.ask).not.toHaveProperty("instructions");
    draft.instructions = " 真的问题 ";
    expect(buildQuestions([draft]).questions.ask?.instructions).toBe("真的问题");
  });

  test("问题名 trim；空名与重名都报出来（而不是等网关 422）", () => {
    const a = newQuestionDraft("  dup  ", "noul");
    const b = newQuestionDraft("dup", "noul");
    const c = newQuestionDraft("   ", "noul");
    const { questions, problems } = buildQuestions([a, b, c]);
    expect(Object.keys(questions)).toEqual(["dup"]);
    expect(problems).toEqual([{ kind: "duplicate", name: "dup" }, { kind: "empty-name", index: 2 }]);
  });
});

describe("AI 生成 → 编辑器 → 再生成请求体（来回一圈不丢东西）", () => {
  test("三种形状都还原成可编辑控件", () => {
    const drafts = draftFromQuestions({
      department: { type: "choice", instructions: "哪个团队？", criteria: { billing: "发票、退款", technical: null } },
      urgency: { type: "score", instructions: "多紧急？", criteria: ["不紧急", "很快", "阻塞"] },
      refund: { type: "noul", instructions: "要退款吗？", criteria: { true: "提到多扣了", false: "没提钱" } },
    });
    expect(drafts.map((d) => d.type)).toEqual(["choice", "score", "noul"]);
    expect(drafts[0]?.options).toEqual([
      { label: "billing", desc: "发票、退款" },
      { label: "technical", desc: "" },
    ]);
    expect(drafts[1]?.levels).toEqual(["不紧急", "很快", "阻塞"]);
    expect(drafts[2]?.trueDesc).toBe("提到多扣了");
    expect(drafts[2]?.falseDesc).toBe("没提钱");
  });

  test("来回一圈：草稿 → 请求体 → 草稿 → 请求体，内容一致", () => {
    const first = buildQuestions(jevExamples("zh")[0]!.questions).questions;
    const again = buildQuestions(draftFromQuestions(first)).questions;
    expect(again).toEqual(first);
  });

  test("模型漏给 criteria 时留一行空白，而不是空列表（否则用户没法接着填）", () => {
    const drafts = draftFromQuestions({ pick: { type: "choice", instructions: "?" } });
    expect(drafts[0]?.options).toEqual([{ label: "", desc: "" }]);
    const score = draftFromQuestions({ rate: { type: "score", instructions: "?" } });
    expect(score[0]?.levels).toEqual([]);
  });

  test("结构化 criteria（对象 / 数组）降级成 JSON 文本，不丢信息", () => {
    const drafts = draftFromQuestions({
      rate: { type: "score", instructions: "?", criteria: [{ what: "外观问题" }, "能用"] },
    });
    expect(drafts[0]?.levels).toEqual(['{"what":"外观问题"}', "能用"]);
  });
});

describe("新问题的默认名", () => {
  test("不与已有名字冲突", () => {
    const drafts = [newQuestionDraft("category_1", "choice")];
    expect(uniqueQuestionName(drafts, "choice")).not.toBe("category_1");
    const names = new Set([uniqueQuestionName([], "noul"), uniqueQuestionName([newQuestionDraft("question_1", "noul")], "noul")]);
    expect(names.size).toBe(2);
  });
});

describe("调用示例", () => {
  test("带官方 SDK 的两行环境变量、三种语言、并把当前请求内联进去", () => {
    const { questions } = buildQuestions(jevExamples("zh")[0]!.questions);
    const text = buildCallExample("state 文本", questions);
    expect(text).toContain("TYPESAFE_BASE_URL=");
    expect(text).toContain("TYPESAFE_API_KEY=");
    expect(text).toContain("curl -s ");
    expect(text).toContain("/v1/systemone");
    expect(text).toContain("from typesafe_sdk import TypeSafeClient");
    expect(text).toContain('from "@typesafe-ai/sdk"');
    expect(text).toContain('"state 文本"');
    // 示例里不能出现任何真 Key 的痕迹。
    expect(text).toContain("<设置 → 网关 → API Key>");
  });

  test("可以指定网关地址（复制给别人的时候要能换）", () => {
    const text = buildCallExample("s", {}, "http://192.0.2.10:10000");
    expect(text).toContain("http://192.0.2.10:10000/v1/systemone");
  });
});
