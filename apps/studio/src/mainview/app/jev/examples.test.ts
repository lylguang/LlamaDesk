/**
 * 内置示例的测试。
 *
 * 两个容易悄悄坏掉的点：示例的 id 在两种语言里必须一致（否则中文下选的示例，切到英文
 * 侧栏就高亮不出来），以及每个示例的草稿必须能通过同一套校验 —— 示例是要"点一下就
 * 能跑"的，装进去却报 422 比没有示例更糟。
 */
import { describe, expect, test } from "bun:test";

import { validateSystemOneRequest } from "../../../shared/systemone";
import { buildQuestions } from "./drafts";
import { jevExamples } from "./examples";

describe("内置示例", () => {
  test("中英两套的 id 集合一致（切换语言不会丢示例）", () => {
    const zh = jevExamples("zh").map((example) => example.id);
    const en = jevExamples("en").map((example) => example.id);
    expect(zh).toEqual(en);
    expect(zh.length).toBeGreaterThanOrEqual(4);
    expect(new Set(zh).size).toBe(zh.length);
  });

  test("每个示例都能通过官方校验（点一下就能跑）", () => {
    for (const lang of ["zh", "en"]) {
      for (const example of jevExamples(lang)) {
        const { questions, problems } = buildQuestions(example.questions);
        expect(problems).toEqual([]);
        const validated = validateSystemOneRequest({
          state: example.state,
          model: "jev-latest",
          questions,
        });
        expect(validated.ok).toBe(true);
        expect(Object.keys(questions).length).toBeGreaterThan(0);
      }
    }
  });

  test("三种原语在示例里都出现过（用户能照着抄到每种写法）", () => {
    const types = new Set(jevExamples("zh").flatMap((example) => example.questions.map((q) => q.type)));
    expect([...types].sort()).toEqual(["choice", "noul", "score"]);
  });

  test("示例的中文版确实是中文（不是共用英文数据）", () => {
    const zh = jevExamples("zh").find((example) => example.id === "triage");
    const en = jevExamples("en").find((example) => example.id === "triage");
    expect(zh?.state).toMatch(/[\u4e00-\u9fa5]/);
    expect(en?.state).not.toMatch(/[\u4e00-\u9fa5]/);
  });

  test("未知语言回落中文（默认语言）", () => {
    expect(jevExamples("fr").map((example) => example.id)).toEqual(jevExamples("zh").map((e) => e.id));
  });

  test("打开页面装载的那一份（当前语言的第一个示例）能直接点运行", () => {
    for (const lang of ["zh", "en"]) {
      const first = jevExamples(lang)[0];
      expect(first).toBeTruthy();
      const { questions, problems } = buildQuestions(first!.questions);
      expect(problems).toEqual([]);
      expect(validateSystemOneRequest({ state: first!.state, model: "jev-latest", questions }).ok).toBe(true);
    }
  });
});
