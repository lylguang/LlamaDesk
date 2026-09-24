/**
 * SystemOne 契约的单元测试。
 *
 * 这里守的是「与官方一致」这件事本身：模型别名、校验产生的 422 detail、错误体、
 * 请求 id 形状。任何一条改动都会让"官方 SDK 换 Base URL 就能用"悄悄失效，
 * 而失效的表现是客户端拿到一个它不认识的错误 —— 所以这些断言写得比较死。
 */
import { describe, expect, test } from "bun:test";

import {
  findSystemOnePassthroughBases,
  parseSystemOneModelListing,
  SYSTEMONE_AUTH_MESSAGES,
  SYSTEMONE_DEFAULT_MODEL,
  SYSTEMONE_LOCAL_MODEL_NAMES,
  SYSTEMONE_MODELS,
  SYSTEMONE_PRICING,
  findSystemOneModel,
  newSystemOneRequestId,
  systemOneAuthErrorBody,
  systemOneModelCards,
  systemOneValidationBody,
  validateSystemOneRequest,
} from "./systemone";

function errorsOf(body: unknown): Record<string, unknown>[] {
  const detail = (body as { detail: Record<string, unknown>[] }).detail;
  return detail;
}

describe("模型目录", () => {
  test("别名解析到官方版本号", () => {
    expect(findSystemOneModel("jev-latest")?.version).toBe("jev-1.13.0");
    expect(findSystemOneModel("jev-preview")?.version).toBe("jev-1.13.0");
    expect(findSystemOneModel("jev-1.13.0")?.version).toBe("jev-1.13.0");
    expect(findSystemOneModel("jev-latest")?.backend).toBe("cloud");
  });

  test("本地模型带权重 repo 且单独归类", () => {
    const local = findSystemOneModel("laya-latest");
    expect(local?.backend).toBe("local");
    expect(local?.weights).toBe("aac6fef/laya-mlx");
    expect(SYSTEMONE_LOCAL_MODEL_NAMES).toContain("laya-multilingual");
  });

  test("未知模型 / 空名返回 null", () => {
    expect(findSystemOneModel("gpt-4o")).toBeNull();
    expect(findSystemOneModel("")).toBeNull();
    expect(findSystemOneModel("  ")).toBeNull();
  });

  test("给网关的卡片只有官方的三个字段", () => {
    const cards = systemOneModelCards();
    expect(cards.length).toBe(SYSTEMONE_MODELS.length);
    for (const card of cards) {
      expect(Object.keys(card).sort()).toEqual(["description", "name", "release_date"]);
      expect(card.name).toBeTruthy();
      expect(card.description).toBeTruthy();
      // 官方用 YYYY-MM-DD。
      expect(card.release_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(cards.map((c) => c.name)).toContain(SYSTEMONE_DEFAULT_MODEL);
  });

  test("价格是 0（免费）", () => {
    expect(SYSTEMONE_PRICING).toEqual({ inputPerMTok: 0, outputPerMTok: 0 });
  });
});

describe("请求校验（422 的 detail 形状）", () => {
  test("合法请求原样通过，且 trim 模型名", () => {
    const result = validateSystemOneRequest({
      state: "hello",
      model: "  jev-latest  ",
      questions: { a: { type: "noul", instructions: "?" } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.model).toBe("jev-latest");
  });

  test("state 可以是对象或数组", () => {
    for (const state of [{ a: 1 }, [1, 2, "x"]]) {
      expect(validateSystemOneRequest({ state, model: "jev-latest", questions: { a: { type: "noul" } } }).ok).toBe(true);
    }
  });

  test("state 为 null 被拒（官方 openapi 里没有 null）", () => {
    const result = validateSystemOneRequest({ state: null, model: "jev-latest", questions: { a: { type: "noul" } } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.loc).toEqual(["body", "state"]);
      expect(result.errors[0]?.type).toBe("model_attributes_type");
    }
  });

  test("缺字段报 missing，loc 指到具体位置", () => {
    const result = validateSystemOneRequest({ model: "jev-latest" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const byLoc = new Map(result.errors.map((e) => [e.loc.join("."), e.type]));
      expect(byLoc.get("body.state")).toBe("missing");
      expect(byLoc.get("body.questions")).toBe("missing");
    }
  });

  test("questions 不能为空（minProperties: 1）", () => {
    const result = validateSystemOneRequest({ state: "s", model: "m", questions: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.loc).toEqual(["body", "questions"]);
      expect(result.errors[0]?.type).toBe("too_short");
      expect(result.errors[0]?.ctx).toEqual({ min_length: 1 });
    }
  });

  test("score 的 criteria 必填且至少一档；choice 的 criteria 必须是映射", () => {
    const score = validateSystemOneRequest({
      state: "s",
      model: "m",
      questions: { a: { type: "score" } },
    });
    expect(score.ok).toBe(false);
    if (!score.ok) expect(score.errors[0]?.type).toBe("missing");

    const emptyScore = validateSystemOneRequest({
      state: "s",
      model: "m",
      questions: { a: { type: "score", criteria: [] } },
    });
    expect(emptyScore.ok).toBe(false);
    if (!emptyScore.ok) {
      expect(emptyScore.errors[0]?.loc).toEqual(["body", "questions", "a", "criteria"]);
      expect(emptyScore.errors[0]?.type).toBe("too_short");
    }

    const badChoice = validateSystemOneRequest({
      state: "s",
      model: "m",
      questions: { a: { type: "choice", criteria: ["x"] } },
    });
    expect(badChoice.ok).toBe(false);
    if (!badChoice.ok) expect(badChoice.errors[0]?.type).toBe("model_attributes_type");
  });

  test("score 只给一档时放行（官方 openapi 是 minItems: 1，JS SDK 客户端自己拦 2 档）", () => {
    const result = validateSystemOneRequest({
      state: "s",
      model: "m",
      questions: { a: { type: "score", criteria: ["only"] } },
    });
    expect(result.ok).toBe(true);
  });

  test("noul 可以完全没有 instructions / criteria（官方的可选性）", () => {
    const result = validateSystemOneRequest({
      state: "s",
      model: "m",
      questions: { a: { type: "noul" } },
    });
    expect(result.ok).toBe(true);
  });

  test("noul 的 criteria 只认 true / false 两个键，值要能当内容用", () => {
    expect(
      validateSystemOneRequest({
        state: "s",
        model: "m",
        questions: { a: { type: "noul", criteria: { true: "yes means this", false: null } } },
      }).ok,
    ).toBe(true);
    const bad = validateSystemOneRequest({
      state: "s",
      model: "m",
      questions: { a: { type: "noul", criteria: { true: 123 } } },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0]?.loc).toEqual(["body", "questions", "a", "criteria", "true"]);
  });

  test("type 不是三个原语之一时报 literal_error", () => {
    const result = validateSystemOneRequest({
      state: "s",
      model: "m",
      questions: { a: { type: "rating" } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.type).toBe("literal_error");
      expect(result.errors[0]?.loc).toEqual(["body", "questions", "a", "type"]);
    }
  });

  test("body 不是对象时报 body 级错误", () => {
    const result = validateSystemOneRequest("nope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.loc).toEqual(["body"]);
  });

  test("组合问题类型：一次请求里三种原语共存", () => {
    const result = validateSystemOneRequest({
      state: { resume: "…" },
      model: "jev-latest",
      questions: {
        department: { type: "choice", instructions: "which team?", criteria: { billing: "refunds", technical: null } },
        urgency: { type: "score", instructions: "how urgent?", criteria: [{ what: "cosmetic" }, "needs attention"] },
        refund: { type: "noul", criteria: { true: "asks for money back" } },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.keys(result.value.questions)).toHaveLength(3);
  });

  test("422 body 就是 { detail: [...] }", () => {
    const result = validateSystemOneRequest({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const body = systemOneValidationBody(result.errors);
      expect(Object.keys(body)).toEqual(["detail"]);
      expect(errorsOf(body).length).toBeGreaterThan(0);
      for (const entry of errorsOf(body)) {
        expect(typeof entry.msg).toBe("string");
        expect(typeof entry.type).toBe("string");
        expect(Array.isArray(entry.loc)).toBe(true);
      }
    }
  });
});

describe("鉴权错误体与请求 id", () => {
  test("缺 Key / Key 无效是两条不同的官方文案", () => {
    expect(systemOneAuthErrorBody("missing")).toEqual({
      detail: { error_type: "authentication_error", message: SYSTEMONE_AUTH_MESSAGES.missing },
    });
    expect(systemOneAuthErrorBody("invalid").detail.message).toBe(SYSTEMONE_AUTH_MESSAGES.invalid);
    expect(SYSTEMONE_AUTH_MESSAGES.missing).toContain("Must supply an API key!");
  });

  test("请求 id 是 req_ + 32 位 hex，且每次不同", () => {
    const a = newSystemOneRequestId();
    const b = newSystemOneRequestId();
    expect(a).toMatch(/^req_[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe("自动发现：模型清单的两种形状", () => {
  test("官方形状（models[]）读成判定模型", () => {
    // 实测 /jev/laya 的响应：官方 TypeSafe 那套卡片。
    const listing = parseSystemOneModelListing({
      models: [
        { name: "jev-1.13.0", description: "Jev 1.13, TypeSafe's flagship System One model.", release_date: "2026-09-15" },
        { name: "jev-latest", description: "Alias for the most recent stable Jev release.", release_date: "2026-09-15" },
      ],
    });
    expect(listing.jev.map((m) => m.name)).toEqual(["jev-1.13.0", "jev-latest"]);
    expect(listing.jev[0]?.release_date).toBe("2026-09-15");
    expect(listing.others).toHaveLength(0);
  });

  test("OpenAI 形状（data[]）读成其它模型，并带上上下文配置", () => {
    // 实测某 LiteLLM 代理的响应：只有聊天模型，没有判定模型。
    const listing = parseSystemOneModelListing({
      object: "list",
      data: [
        { id: "deepseek-v4.1-flash", object: "model", owned_by: "openai" },
        { id: "qwen3.8-27b", object: "model", owned_by: "openai", max_input_tokens: 262144, max_output_tokens: 32768 },
      ],
    });
    expect(listing.jev).toHaveLength(0);
    expect(listing.others.map((m) => m.name)).toEqual(["deepseek-v4.1-flash", "qwen3.8-27b"]);
    expect(listing.others[1]?.max_input_tokens).toBe(262144);
    expect(listing.others[1]?.owned_by).toBe("openai");
  });

  test("两种形状同时给：同名模型合并成一行，字段互补", () => {
    // 实测 /jev/openjev 就是这样回的 —— 分开列会让同一个模型出现两次。
    const listing = parseSystemOneModelListing({
      models: [
        { name: "jev-latest", description: "OpenJev classification using Qwen/Qwen3.6-35B-A3B-AWQ", release_date: "2026-09-17" },
      ],
      object: "list",
      data: [
        { id: "jev-latest", object: "model", owned_by: "openjev" },
        { id: "some-chat-model", object: "model", owned_by: "openai" },
      ],
    });
    expect(listing.jev.map((m) => m.name)).toEqual(["jev-latest"]);
    // description 来自卡片，owned_by 来自 OpenAI 那侧。
    expect(listing.jev[0]?.description).toContain("OpenJev");
    expect(listing.jev[0]?.owned_by).toBe("openjev");
    expect(listing.others.map((m) => m.name)).toEqual(["some-chat-model"]);
  });

  test("读不懂的 body 返回空清单，不抛", () => {
    for (const raw of [null, "nope", 42, {}, { models: "x" }]) {
      expect(parseSystemOneModelListing(raw)).toEqual({ jev: [], others: [] });
    }
    // 裸数组：有 id 的当 OpenAI 记录，只有 name 的当官方卡片。
    expect(parseSystemOneModelListing([{ id: "a" }]).others.map((m) => m.name)).toEqual(["a"]);
    expect(parseSystemOneModelListing(["a", "b"]).jev.map((m) => m.name)).toEqual(["a", "b"]);
  });
});

describe("自动发现：判定服务挂在子路径上", () => {
  test("认出网关的 pass-through 前缀（名字里带 jev / laya）", () => {
    // 实测某 LiteLLM 代理的 openapi.json：判定服务转发在 /jev/<名字> 下，
    // 而 /v1/models 只列得出它自己代理的聊天模型。
    const bases = findSystemOnePassthroughBases({
      paths: {
        "/v1/models": {},
        "/v1/chat/completions": {},
        "/jev/openjev": {},
        "/jev/openjev/{subpath}": {},
        "/jev/laya": {},
        "/jev/laya/{subpath}": {},
        "/anthropic/{subpath}": {},
      },
    });
    expect(bases).toEqual(["/jev/openjev", "/jev/laya"]);
  });

  test("写明了 /v1/systemone 的前缀排在最前（那是最硬的证据）", () => {
    const bases = findSystemOnePassthroughBases({
      paths: { "/jev/laya/{subpath}": {}, "/judge/v1/systemone": {}, "/v1/systemone": {} },
    });
    // 根路径自己的 /v1/systemone 前缀是空串，不算候选。
    expect(bases).toEqual(["/judge", "/jev/laya"]);
  });

  test("不是 OpenAPI 文档就返回空", () => {
    for (const raw of [null, "x", {}, { paths: 1 }]) expect(findSystemOnePassthroughBases(raw)).toEqual([]);
  });
});
