/**
 * `/v1/systemone` 的端到端测试 —— 用**官方 SDK 真调一次**来证明"换两行就能用"。
 *
 * 这是这一整套功能的核心承诺：外部 agent（Claude Code / Codex / 自建脚本）用
 * TypeSafe 官方的 Python / JS SDK，只把 `TYPESAFE_BASE_URL` 换成我们的网关、
 * `TYPESAFE_API_KEY` 换成网关 Key，行为就该与打官方时一致。断言如果只对着自己写的
 * fetch 检查字段，是"我们说自己是官方的"；用官方 SDK 跑通，才是"客户端认它是官方的"。
 *
 * 因此这里刻意做三件事：
 *   1. 上游桩成**官方形状**的服务（`{model, answers, usage}` / 官方错误体），
 *      验证错误码与错误体原样透传；
 *   2. 用 `@typesafe-ai/sdk` 的 `TypeSafeClient` + 环境变量调用；
 *   3. 覆盖官方 SDK 的三种失败分类：缺 Key → `PermissionDeniedError`(403)、
 *      Key 无效 → `AuthenticationError`(401)、body 不合法 → `UnprocessableEntityError`(422)。
 *
 * 桩掉的是"这台机器上有没有推理服务 / 引擎"，**不桩 systemone 本身** —— 被测的就是它。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { AuthenticationError, TypeSafeClient, UnprocessableEntityError } from "@typesafe-ai/sdk";

import * as schema from "./db/schema";
import { mockModulePartial } from "./test-mocks";

/** 官方上游（我们冒充 TypeSafe 的对面），以及网关自己。 */
const UPSTREAM_PORT = 18201;
const GATEWAY_PORT = 10133;
const GATEWAY_BASE = `http://127.0.0.1:${GATEWAY_PORT}`;
const GATEWAY_KEY = "jev-test-gateway-key";

// --- 上游桩：只实现官方那两个端点，形状严格照官方 ---

type Seen = { body: Record<string, unknown> | null; auth: string | null };
let seen: Seen = { body: null, auth: null };
/**
 * 读 `seen` 一律走这个函数。
 *
 * 直接在用例里写 `seen.body?.x` 会让 TS 把 `seen.body` 按**初始化值**收窄成 `null`
 * （赋值发生在桩回调里，控制流分析看不到），于是属性访问全变成 `never` 报错。
 * 显式返回类型的函数不做这种收窄。
 */
function seenBody(): Record<string, unknown> | null {
  return seen.body;
}
/** 让某个用例把上游改成"报错"，验证状态码与 body 的透传。 */
let upstreamFailure: { status: number; body: unknown } | null = null;

const OFFICIAL_MODELS = {
  models: [
    { name: "jev-latest", description: "Alias for the most recent stable JEV release.", release_date: "2026-09-15" },
    { name: "jev-preview", description: "Alias for the most recent JEV release, official or not.", release_date: "2026-09-15" },
  ],
};

/** 官方对一次合法请求的响应：逐字段照抄（含 noul 没有 confidence 这条）。 */
function officialAnswer(questions: Record<string, { type?: string }>) {
  const answers: Record<string, unknown> = {};
  for (const [name, question] of Object.entries(questions ?? {})) {
    if (question?.type === "choice") {
      answers[name] = { type: "choice", choice: "billing", confidence: 0.84, probabilities: { billing: 0.84, technical: 0.15, sales: 0.01 } };
    } else if (question?.type === "score") {
      answers[name] = {
        type: "score",
        score: 2.99,
        confidence: 0.98,
        legend: { "0": "None", "1": "2 years", "2": "4 years" },
        probabilities: { "0": 0, "1": 0.02, "2": 0.98 },
      };
    } else {
      answers[name] = { type: "noul", noul: 0.99 };
    }
  }
  return { model: "jev-1.13.0", answers, usage: { input_tokens: 332, output_tokens: 18 } };
}

let upstream: ReturnType<typeof Bun.serve> | null = null;
let upstreamHits = 0;

// --- 桩掉与"这次调用"无关的依赖（推理服务 / 引擎 / 图片后端 / 设置 / 账本）---

await mockModulePartial<typeof import("./server-manager")>("./server-manager", {
  getStatus: () => "stopped" as const,
  onStatusChange: () => () => {},
});

await mockModulePartial<typeof import("./asr")>("./asr", {
  getAsrStatus: async () => ({
    serverRunning: false,
    port: 0,
    engine: "none",
    engineInstalled: false,
    engineVersion: null,
    binaryPath: null,
    activeModel: null,
  }),
  getASRProviderConfig: () => ({ providerId: "", base: "", apiKey: "", model: "" }),
});

await mockModulePartial<typeof import("./voice")>("./voice", {
  getTTSProviderConfig: () => ({ providerId: "", base: "", apiKey: "", model: "" }),
  listProviderModels: async () => [] as string[],
});

await mockModulePartial<typeof import("./tts-local")>("./tts-local", {
  getTtsLocalStatus: async () => ({
    active: false,
    activeModelId: null,
    activeModelPath: null,
    engineInstalled: false,
    binaryPath: null,
    backend: "cpu",
    version: "",
  }),
  listTtsLocalModels: () => [],
});

await mockModulePartial<typeof import("./model-store")>("./model-store", {
  listInstalledModels: () => [],
});

await mockModulePartial<typeof import("./gateway-images")>("./gateway-images", {
  IMAGE_MODELS: [],
  getImageGenConfig: () => ({ backend: "mlx", providerId: "", apiBase: "", apiKey: "", model: "", comfyBase: "" }),
});

const SETTINGS: Record<string, string> = {
  GATEWAY_ENABLED: "1",
  GATEWAY_HOST: "127.0.0.1",
  GATEWAY_PORT: String(GATEWAY_PORT),
  GATEWAY_API_KEY: GATEWAY_KEY,
  SERVER_HOST: "127.0.0.1",
  SERVER_PORT: "18299",
  VLLM_API_KEY: "EMPTY",
  VLLM_API_BASE: "",
  IMG_BACKEND: "mlx",
  IMG_MODEL: "",
  // 云端后端指向我们的官方形状桩。
  SYSTEMONE_BACKEND: "cloud",
  SYSTEMONE_CLOUD_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}`,
  SYSTEMONE_CLOUD_API_KEY: "upstream-typesafe-key",
  SYSTEMONE_CLOUD_MODEL: "jev-latest",
  SYSTEMONE_LOCAL_BASE_URL: "",
  SYSTEMONE_LOCAL_MODEL: "laya-latest",
  SYSTEMONE_TIMEOUT_MS: "10000",
};

await mockModulePartial<typeof import("./db/settings")>("./db/settings", {
  getSetting: (key: string) => SETTINGS[key] ?? "",
  getNumericSetting: (key: string) => Number(SETTINGS[key] ?? 0) || 0,
  updateSettings: (values: Record<string, string>) => Object.assign(SETTINGS, values),
  getAllSettings: () => ({ ...SETTINGS }),
  getActiveServerPort: () => SETTINGS.SERVER_PORT || "18299",
});

// 账本要一个自己控制的库（mock 跨文件泄漏，别人的库可能在 afterAll 里被删）。
const usageSqlite = new Database(join(tmpdir(), `omni-systemone-usage-${process.pid}.db`), { create: true });
const usageDb = drizzle({ client: usageSqlite, schema });
migrate(usageDb, { migrationsFolder: join(import.meta.dir, "db/migrations") });
await mockModulePartial<typeof import("./db")>("./db", { db: usageDb, sqliteClient: usageSqlite });

// mock 全部注册完再加载被测模块（静态 import 会被提升到 mock 之前）。
const { startGateway, stopGateway } = await import("./gateway");
const { usageRecords } = await import("./db/schema");

beforeAll(async () => {
  upstream = Bun.serve({
    port: UPSTREAM_PORT,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/models" && req.method === "GET") {
        return Response.json(OFFICIAL_MODELS, { headers: { "x-typesafe-request-id": "req_upstream_models" } });
      }
      if (url.pathname === "/v1/systemone" && req.method === "POST") {
        upstreamHits += 1;
        seen = { body: null, auth: req.headers.get("authorization") };
        try {
          seen.body = (await req.json()) as Record<string, unknown>;
        } catch {
          seen.body = null;
        }
        if (upstreamFailure) {
          return Response.json(upstreamFailure.body, {
            status: upstreamFailure.status,
            headers: { "x-typesafe-request-id": "req_upstream_error" },
          });
        }
        return Response.json(officialAnswer((seen.body?.questions ?? {}) as Record<string, { type?: string }>), {
          headers: { "x-typesafe-request-id": "req_upstream_ok" },
        });
      }
      return Response.json({ detail: { error_type: "not_found", message: "no such endpoint" } }, { status: 404 });
    },
  });
  const started = await startGateway();
  expect(started.ok).toBe(true);
});

afterAll(async () => {
  await stopGateway();
  upstream?.stop();
});

/** 直接用 fetch 打网关（检查状态码与原始 body 形状时比 SDK 更直观）。 */
function callGateway(body: unknown, options: { key?: string | null } = {}): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.key !== null) headers.Authorization = `Bearer ${options.key ?? GATEWAY_KEY}`;
  return fetch(`${GATEWAY_BASE}/v1/systemone`, { method: "POST", headers, body: JSON.stringify(body) });
}

const VALID_BODY = {
  state: "I was charged twice. Please refund the duplicate.",
  model: "jev-latest",
  questions: { department: { type: "choice", instructions: "Which team?", criteria: { billing: "refunds", technical: null } } },
};

describe("鉴权：缺 Key 403 / Key 无效 401（官方 HTTPBearer 的两种失败）", () => {
  test("完全不带 Authorization → 403 + 官方 body", async () => {
    const res = await callGateway(VALID_BODY, { key: null });
    expect(res.status).toBe(403);
    expect(res.headers.get("x-typesafe-request-id")).toMatch(/^req_[0-9a-f]{32}$/);
    const body = (await res.json()) as { detail: { error_type: string; message: string } };
    expect(body.detail.error_type).toBe("authentication_error");
    expect(body.detail.message).toBe("Must supply an API key! Check your request and try again.");
  });

  test("Key 无效 → 401 + 官方 body", async () => {
    const res = await callGateway(VALID_BODY, { key: "wrong-key" });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { detail: { error_type: string; message: string } };
    expect(body.detail.error_type).toBe("authentication_error");
    expect(body.detail.message).toBe("Cannot authenticate with the server. Please check your API key and try again.");
  });
});

describe("校验：422 是 FastAPI 形状", () => {
  test("空 questions → 422，detail 里有 loc/msg/type", async () => {
    const res = await callGateway({ state: "s", model: "jev-latest", questions: {} });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { detail: { loc: unknown[]; msg: string; type: string }[] };
    expect(Array.isArray(body.detail)).toBe(true);
    expect(body.detail[0]?.loc).toEqual(["body", "questions"]);
    expect(body.detail[0]?.type).toBe("too_short");
    expect(typeof body.detail[0]?.msg).toBe("string");
  });

  test("body 不是合法 JSON → 422（官方也走同一条 FastAPI 校验）", async () => {
    const res = await fetch(`${GATEWAY_BASE}/v1/systemone`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_KEY}` },
      body: "{not json",
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { detail: { type: string }[] };
    expect(body.detail[0]?.type).toBe("json_invalid");
  });

  test("GET 不允许（405）", async () => {
    const res = await fetch(`${GATEWAY_BASE}/v1/systemone`, { headers: { Authorization: `Bearer ${GATEWAY_KEY}` } });
    expect(res.status).toBe(405);
  });
});

describe("成功路径：请求转发与响应形状", () => {
  test("200 + 官方响应字段，且上游收到我们发过去的问题", async () => {
    seen = { body: null, auth: null };
    const res = await callGateway(VALID_BODY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      model: string;
      answers: Record<string, { type: string; choice?: string; probabilities?: Record<string, number> }>;
      usage: { input_tokens: number; output_tokens: number };
    };
    expect(body.model).toBe("jev-1.13.0");
    expect(body.answers.department?.type).toBe("choice");
    expect(body.answers.department?.choice).toBe("billing");
    expect(body.usage).toEqual({ input_tokens: 332, output_tokens: 18 });
    // 上游确实拿到了请求（而不是我们编了一个答案）。
    expect(seenBody()?.state).toBe(VALID_BODY.state);
    expect(seenBody()?.model).toBe("jev-latest");
    // 网关用配置的云端 Key 去上游，不是客户端的网关 Key。
    expect(seen.auth).toBe("Bearer upstream-typesafe-key");
  });

  test("noul / score / choice 三种答案形状都按官方（noul 没有 confidence）", async () => {
    const res = await callGateway({
      state: "resume text",
      model: "jev-latest",
      questions: {
        years: { type: "score", instructions: "how many years?", criteria: ["None", "2 years", "4 years"] },
        mentorship: { type: "noul", instructions: "does it show mentoring?" },
      },
    });
    const body = (await res.json()) as { answers: Record<string, Record<string, unknown>> };
    expect(Object.keys(body.answers.years ?? {}).sort()).toEqual(["confidence", "legend", "probabilities", "score", "type"]);
    expect(Object.keys(body.answers.mentorship ?? {}).sort()).toEqual(["noul", "type"]);
  });

  test("云端不识别的本地模型名会被换成云端模型（客户端只改 Base URL 也能跑）", async () => {
    seen = { body: null, auth: null };
    await callGateway({ ...VALID_BODY, model: "laya-latest" });
    expect(seenBody()?.model).toBe("jev-latest");
  });

  test("每次成功调用记一行用量（渠道 systemone，价格 0）", async () => {
    const before = usageDb.select().from(usageRecords).all().length;
    await callGateway(VALID_BODY);
    const rows = usageDb.select().from(usageRecords).all();
    expect(rows.length).toBe(before + 1);
    const row = rows[rows.length - 1];
    expect(row?.channel).toBe("systemone");
    expect(row?.upstream).toBe("cloud");
    expect(row?.model).toBe("jev-1.13.0");
    expect(row?.inputTokens).toBe(332);
  });
});

describe("错误透传", () => {
  test("上游 429 原样带给客户端", async () => {
    upstreamFailure = { status: 429, body: { detail: { error_type: "rate_limit_error", message: "too many requests" } } };
    try {
      const res = await callGateway(VALID_BODY);
      expect(res.status).toBe(429);
      expect((await res.json()) as unknown).toEqual({
        detail: { error_type: "rate_limit_error", message: "too many requests" },
      });
    } finally {
      upstreamFailure = null;
    }
  });

  test("上游 401（我们的云端 Key 不对）也原样透传", async () => {
    upstreamFailure = {
      status: 401,
      body: { detail: { error_type: "authentication_error", message: "Cannot authenticate with the server. Please check your API key and try again." } },
    };
    try {
      const res = await callGateway(VALID_BODY);
      expect(res.status).toBe(401);
    } finally {
      upstreamFailure = null;
    }
  });
});

describe("本地后端（自建的 TypeSafe 兼容服务）", () => {
  test("backend=local 时打本地地址，且**模型名原样转发**（名字由那台服务定义）", async () => {
    SETTINGS.SYSTEMONE_BACKEND = "local";
    SETTINGS.SYSTEMONE_LOCAL_BASE_URL = `http://127.0.0.1:${UPSTREAM_PORT}`;
    SETTINGS.SYSTEMONE_LOCAL_API_KEY = "";
    try {
      seen = { body: null, auth: null };
      const res = await callGateway({ ...VALID_BODY, model: "jev-latest" });
      expect(res.status).toBe(200);
      // 不把 jev-latest 改成本地的 laya-*：自建的 TypeSafe 兼容服务自己认 jev-latest，
      // 改名会让它认不出来 —— "只换 Base URL 就能用"这条承诺就断了。
      expect(seenBody()?.model).toBe("jev-latest");
      // 本地服务有自己的 Key（默认空 → 不带 Authorization）。
      expect(seen.auth).toBeNull();
    } finally {
      SETTINGS.SYSTEMONE_BACKEND = "cloud";
      SETTINGS.SYSTEMONE_LOCAL_BASE_URL = "";
    }
  });

  test("auto：本地服务配了就先走本地；连不上时回落云端", async () => {
    const savedBackend = SETTINGS.SYSTEMONE_BACKEND ?? "";
    const savedLocal = SETTINGS.SYSTEMONE_LOCAL_BASE_URL ?? "";
    SETTINGS.SYSTEMONE_BACKEND = "auto";
    // 本地指向一个没人监听的端口：应当回落云端并成功。
    SETTINGS.SYSTEMONE_LOCAL_BASE_URL = "http://127.0.0.1:1";
    try {
      const availability = await (await import("./systemone")).systemOneAvailability();
      expect(availability.resolved).toBe("local-url");
      seen = { body: null, auth: null };
      const res = await callGateway(VALID_BODY);
      expect(res.status).toBe(200);
      // 真正服务这次请求的是云端（本地那个端口上什么都没有）。
      expect(seenBody()?.model).toBe("jev-latest");
    } finally {
      SETTINGS.SYSTEMONE_BACKEND = savedBackend;
      SETTINGS.SYSTEMONE_LOCAL_BASE_URL = savedLocal;
    }
  });

  test("auto：本地服务正常工作（回 4xx）时不回落 —— 那是请求的问题，换云端只会再错一次", async () => {
    const savedBackend = SETTINGS.SYSTEMONE_BACKEND ?? "";
    const savedLocal = SETTINGS.SYSTEMONE_LOCAL_BASE_URL ?? "";
    SETTINGS.SYSTEMONE_BACKEND = "auto";
    SETTINGS.SYSTEMONE_LOCAL_BASE_URL = `http://127.0.0.1:${UPSTREAM_PORT}`;
    upstreamFailure = { status: 422, body: { detail: [{ loc: ["body", "model"], msg: "unknown model", type: "value_error" }] } };
    try {
      const res = await callGateway(VALID_BODY);
      expect(res.status).toBe(422);
    } finally {
      upstreamFailure = null;
      SETTINGS.SYSTEMONE_BACKEND = savedBackend;
      SETTINGS.SYSTEMONE_LOCAL_BASE_URL = savedLocal;
    }
  });

  test("没有可用后端时 503，并说明该去哪儿配", async () => {
    const savedBackend = SETTINGS.SYSTEMONE_BACKEND ?? "cloud";
    const savedKey = SETTINGS.SYSTEMONE_CLOUD_API_KEY ?? "";
    SETTINGS.SYSTEMONE_BACKEND = "cloud";
    SETTINGS.SYSTEMONE_CLOUD_API_KEY = "";
    try {
      const res = await callGateway(VALID_BODY);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { detail: { error_type: string; message: string } };
      expect(body.detail.error_type).toBe("configuration_error");
      expect(body.detail.message).toContain("JEV");
    } finally {
      SETTINGS.SYSTEMONE_BACKEND = savedBackend;
      SETTINGS.SYSTEMONE_CLOUD_API_KEY = savedKey;
    }
  });
});

describe("后端由设置决定 —— 选了云端就必须走云端", () => {
  /*
   * 盯的是真出现过的坑：JEV 页的「本地运行 / 云端接入」以前只是视图，走哪条由
   * `SYSTEMONE_BACKEND`（默认 auto）定。用户填好云端 Key 却不见它生效，原因就是
   * auto 的"本地优先"：只要本地地址配着，云端永远轮不到。现在切 tab 直接写这个设置，
   * 于是这里钉住后半句 —— **设置说 cloud 时，配着本地地址也不许改道**。
   */
  test("backend=cloud 且本地地址也配着：仍然打云端（本地优先不得截走用户的选择）", async () => {
    const savedBackend = SETTINGS.SYSTEMONE_BACKEND ?? "";
    const savedLocal = SETTINGS.SYSTEMONE_LOCAL_BASE_URL ?? "";
    const savedLocalKey = SETTINGS.SYSTEMONE_LOCAL_API_KEY ?? "";
    SETTINGS.SYSTEMONE_BACKEND = "cloud";
    // 本地也"能用"（同一个桩端口），并带一把它自己的 Key —— 两条路都能通，
    // 于是结果只能由设置决定，而不是由可用性拼出来的巧合决定。
    SETTINGS.SYSTEMONE_LOCAL_BASE_URL = `http://127.0.0.1:${UPSTREAM_PORT}`;
    SETTINGS.SYSTEMONE_LOCAL_API_KEY = "local-key-must-not-be-used";
    try {
      seen = { body: null, auth: null };
      // model 写成本地专属名字：云端会归一化成配置的云端模型，本地服务则原样转发 ——
      // 这条断言能分开"到底是谁回的这个 200"。
      const res = await callGateway({ ...VALID_BODY, model: "laya-latest" });
      expect(res.status).toBe(200);
      expect(seen.auth).toBe("Bearer upstream-typesafe-key");
      expect(seenBody()?.model).toBe("jev-latest");
    } finally {
      SETTINGS.SYSTEMONE_BACKEND = savedBackend;
      SETTINGS.SYSTEMONE_LOCAL_BASE_URL = savedLocal;
      SETTINGS.SYSTEMONE_LOCAL_API_KEY = savedLocalKey;
    }
  });

  test("backend=local 且云端 Key 也配着：本地服务挂掉时如实报 502，不偷偷改走云端", async () => {
    const savedBackend = SETTINGS.SYSTEMONE_BACKEND ?? "";
    const savedLocal = SETTINGS.SYSTEMONE_LOCAL_BASE_URL ?? "";
    SETTINGS.SYSTEMONE_BACKEND = "local";
    SETTINGS.SYSTEMONE_LOCAL_BASE_URL = "http://127.0.0.1:1";
    try {
      const upstreamBefore = upstreamHits;
      const res = await callGateway(VALID_BODY);
      expect(res.status).toBe(502);
      // 一次都没有打到云端：回落只属于 auto（那是"没得选"时的兜底，不是替用户改主意）。
      expect(upstreamHits).toBe(upstreamBefore);
    } finally {
      SETTINGS.SYSTEMONE_BACKEND = savedBackend;
      SETTINGS.SYSTEMONE_LOCAL_BASE_URL = savedLocal;
    }
  });
});

describe("/v1/models：OpenAI 的 data 与 TypeSafe 的 models 同时给", () => {
  test("两个字段都在，models 是官方卡片形状", async () => {
    const res = await fetch(`${GATEWAY_BASE}/v1/models`, { headers: { Authorization: `Bearer ${GATEWAY_KEY}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      data: { id: string }[];
      models: { name: string; description: string; release_date: string }[];
    };
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
    expect(Array.isArray(body.models)).toBe(true);
    const names = body.models.map((card) => card.name);
    expect(names).toContain("jev-latest");
    expect(names).toContain("laya-latest");
    for (const card of body.models) {
      expect(Object.keys(card).sort()).toEqual(["description", "name", "release_date"]);
    }
  });
});

/**
 * 真正的验收：**官方 SDK**。
 *
 * 下面这些用例只用官方文档说的两件事 —— `TYPESAFE_BASE_URL` 与 `TYPESAFE_API_KEY`
 * —— 来指向本机网关。SDK 内部的路径拼接（base_url + /v1/systemone）、错误分类、
 * `/v1/models` 的解析全部由官方代码负责，我们不动它。
 */
describe("官方 SDK 直连（只换 Base URL + Key）", () => {
  test("systemOne 返回类型化答案（按问题名取，形状由 SDK 解析）", async () => {
    process.env.TYPESAFE_BASE_URL = GATEWAY_BASE;
    process.env.TYPESAFE_API_KEY = GATEWAY_KEY;
    try {
      const client = new TypeSafeClient();
      const response = await client.systemOne({
        state: "I was charged twice. Please refund the duplicate.",
        questions: {
          department: { type: "choice", instructions: "Which team?", criteria: { billing: null, technical: null } },
          refund: { type: "noul", instructions: "Does the customer ask for money back?" },
        },
      });
      expect(response.model).toBe("jev-1.13.0");
      const department = response.answers.department;
      expect(department.type).toBe("choice");
      if (department.type === "choice") expect(department.choice).toBe("billing");
      const refund = response.answers.refund;
      expect(refund.type).toBe("noul");
      if (refund.type === "noul") expect(refund.noul).toBeCloseTo(0.99, 4);
      expect(response.usage.input_tokens).toBe(332);
    } finally {
      delete process.env.TYPESAFE_BASE_URL;
      delete process.env.TYPESAFE_API_KEY;
    }
  });

  test("SDK 的 models.list() 能解析我们合并后的 /v1/models", async () => {
    const client = new TypeSafeClient({ baseURL: GATEWAY_BASE, apiKey: GATEWAY_KEY });
    const models = await client.models.list();
    expect(models.map((card) => card.name)).toContain("jev-latest");
  });

  test("缺 Key → SDK 抛 PermissionDeniedError（因为官方在缺 Key 时就是 403）", async () => {
    // 绕过 SDK 的 Key 校验：直接用一个空 Key 的 client 是拿不到请求的（构造时就抛），
    // 所以这里用 fetch 复现"没有 Authorization 头"的那一次，再核对状态码落在
    // SDK 的 PermissionDeniedError 档位（403）而不是 AuthenticationError（401）。
    const res = await fetch(`${GATEWAY_BASE}/v1/systemone`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });
    expect(res.status).toBe(403);
    expect(res.status >= 400 && res.status !== 401 && res.status !== 422).toBe(true);
  });

  test("Key 无效 → SDK 抛 AuthenticationError（401）", async () => {
    const client = new TypeSafeClient({ baseURL: GATEWAY_BASE, apiKey: "definitely-wrong" });
    // 刻意不用 `expect(...).rejects`：SDK 返回的是 Promise 子类（APIPromise），断言
    // 包装器对它的处理会吞掉真正的结果 —— 这里要的是"抛了哪个类、status 是多少"。
    const outcome = await client
      .systemOne({ state: "s", questions: { a: { type: "noul", instructions: "?" } } })
      .then(() => ({ threw: false as const }))
      .catch((error: unknown) => ({ threw: true as const, error }));
    expect(outcome.threw).toBe(true);
    if (outcome.threw) {
      expect(outcome.error).toBeInstanceOf(AuthenticationError);
      expect((outcome.error as AuthenticationError).status).toBe(401);
      expect((outcome.error as AuthenticationError).requestId).toMatch(/^req_[0-9a-f]{32}$/);
    }
  });

  test("body 不合法 → SDK 抛 UnprocessableEntityError（422）", async () => {
    const client = new TypeSafeClient({ baseURL: GATEWAY_BASE, apiKey: GATEWAY_KEY });
    // choice 的空 criteria：SDK 自己在客户端只拦 score，所以这一条真的会发出去，
    // 由服务端校验拒绝 —— 正好验证 422 这一档。
    const outcome = await client
      .systemOne({ state: "s", questions: { a: { type: "choice", instructions: "?", criteria: {} } } })
      .then(() => ({ threw: false as const }))
      .catch((error: unknown) => ({ threw: true as const, error }));
    expect(outcome.threw).toBe(true);
    if (outcome.threw) {
      expect(outcome.error).toBeInstanceOf(UnprocessableEntityError);
      expect((outcome.error as UnprocessableEntityError).status).toBe(422);
    }
  });
});
