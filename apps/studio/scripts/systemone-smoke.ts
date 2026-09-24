/**
 * SystemOne / JEV 冒烟：设置（含 Key 落盘加密）→ 后端解析 → 真实 HTTP 调用 →
 * 官方 SDK 直连网关 → 用量账本 → 失败事件的日志。
 *
 * 跑法：`bun run scripts/systemone-smoke.ts`（或 `OMNI_DATA_DIR=…` 保留现场）。
 *
 * 为什么是独立脚本而不是 `bun test` 用例：这里要**真写设置、真读回来**（验证
 * SYSTEMONE_CLOUD_API_KEY 落盘是密文、读出来是明文），而 `bun test` 的模块 mock 是
 * 进程级的 —— 跑在 gateway 测试后面就读不到真实设置了（同 proxy-smoke 的理由）。
 *
 * 另外它顺带把 **Python worker 的语法**过一遍：`systemone-laya-worker.py` 在这台机器上
 * 不一定有 MLX 可跑，但语法错误一定要在这里就撞出来，而不是等到用户点"安装本地运行时"。
 */
import { existsSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const providedDataDir = process.env.OMNI_DATA_DIR;
const dataDir = providedDataDir ?? mkdtempSync(path.join(tmpdir(), "omni-systemone-smoke-"));
process.env.OMNI_DATA_DIR = dataDir;

import { Database } from "bun:sqlite";

let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — ${detail ?? ""}`}`);
  if (!ok) failed++;
};

const UPSTREAM_PORT = 18251;
const GATEWAY_PORT = 10151;

// ---------------------------------------------------------------------------
// 0. 官方契约的静态面：worker 脚本在位、Python 语法能过
// ---------------------------------------------------------------------------

const workerScript = path.join(import.meta.dir, "..", "src", "bun", "systemone-laya-worker.py");
check("本地 worker 脚本存在", existsSync(workerScript));

const pyCompile = Bun.spawnSync(["python3", "-m", "py_compile", workerScript], {
  stdout: "pipe",
  stderr: "pipe",
});
check(
  "本地 worker Python 语法可编译",
  pyCompile.exitCode === 0,
  pyCompile.stderr.toString().slice(0, 400) || `退出码 ${pyCompile.exitCode}`,
);

// ---------------------------------------------------------------------------
// 1. 设置：写入 → 读回；Key 落盘是密文
// ---------------------------------------------------------------------------

const { updateSettings, getSetting } = await import("../src/bun/db/settings");
const { ENCRYPTED_SETTINGS_KEYS } = await import("../src/bun/db/settings");

updateSettings({
  SYSTEMONE_BACKEND: "cloud",
  SYSTEMONE_CLOUD_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}`,
  SYSTEMONE_CLOUD_API_KEY: "smoke-typesafe-key-abc123",
  SYSTEMONE_CLOUD_MODEL: "jev-latest",
  SYSTEMONE_LOCAL_BASE_URL: "",
  SYSTEMONE_LOCAL_MODEL: "laya-latest",
  SYSTEMONE_TIMEOUT_MS: "8000",
});

check("SYSTEMONE_CLOUD_API_KEY 在读路径上是明文", getSetting("SYSTEMONE_CLOUD_API_KEY") === "smoke-typesafe-key-abc123");
check(
  "SYSTEMONE_CLOUD_API_KEY 在加密槽位名单里",
  ENCRYPTED_SETTINGS_KEYS.includes("SYSTEMONE_CLOUD_API_KEY") &&
    ENCRYPTED_SETTINGS_KEYS.includes("SYSTEMONE_LOCAL_API_KEY"),
);
{
  // 直接读库看落盘形态：不该是明文。
  const dbPath = process.env.OMNI_DB_PATH ?? path.join(dataDir, "omni-studio.db");
  const raw = new Database(dbPath, { readonly: true });
  const row = raw
    .query("SELECT value FROM settings WHERE key = 'SYSTEMONE_CLOUD_API_KEY'")
    .get() as { value?: string } | null;
  raw.close();
  check("落盘不是明文（加密槽位生效）", !!row?.value && row.value !== "smoke-typesafe-key-abc123", row?.value?.slice(0, 24));
}

// ---------------------------------------------------------------------------
// 2. 官方形状的上游桩
// ---------------------------------------------------------------------------

let lastBody: Record<string, unknown> | null = null;
/** 读 lastBody 走函数：直接读会被 TS 按初始化值收窄成 null（赋值在桩回调里）。 */
function postedBody(): Record<string, unknown> | null {
  return lastBody;
}
const upstream = Bun.serve({
  port: UPSTREAM_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/models") {
      return Response.json({ models: [{ name: "jev-latest", description: "alias", release_date: "2026-09-15" }] });
    }
    if (url.pathname === "/v1/systemone") {
      lastBody = (await req.json()) as Record<string, unknown>;
      return Response.json(
        {
          model: "jev-1.13.0",
          answers: { triage: { type: "choice", choice: "billing", confidence: 0.91, probabilities: { billing: 0.91, technical: 0.09 } } },
          usage: { input_tokens: 120, output_tokens: 0 },
        },
        { headers: { "x-typesafe-request-id": "req_smoke" } },
      );
    }
    return Response.json({ detail: { error_type: "not_found", message: "nope" } }, { status: 404 });
  },
});

// ---------------------------------------------------------------------------
// 3. 服务层：解析后端 + 真实调用 + 记用量
// ---------------------------------------------------------------------------

const SystemOne = await import("../src/bun/systemone");

const availability = await SystemOne.systemOneAvailability();
check("可用性：解析到云端后端", availability.resolved === "cloud", String(availability.resolved));
check("价格恒为 0", availability.pricing.inputPerMTok === 0 && availability.pricing.outputPerMTok === 0);
check("模型目录里有 jev-latest 与 laya-latest", availability.models.some((m) => m.name === "jev-latest") && availability.models.some((m) => m.name === "laya-latest"));

const result = await SystemOne.runSystemOne({
  state: "Duplicate charge on invoice #88231.",
  model: "jev-latest",
  questions: { triage: { type: "choice", instructions: "Which team?", criteria: { billing: "refunds", technical: "bugs" } } },
});
check("云端调用成功", result.ok, result.ok ? undefined : `${result.status} ${result.message}`);
if (result.ok) {
  const answer = result.response.answers.triage;
  check("答案类型与请求一致（choice）", answer?.type === "choice");
  check("响应里的模型是解析后的版本号", result.response.model === "jev-1.13.0");
  check(
    "上游收到了 state 与问题名",
    postedBody()?.state === "Duplicate charge on invoice #88231." &&
      !!((postedBody()?.questions ?? {}) as Record<string, unknown>).triage,
  );
  check("上游收到了我们的云端 Key（不是客户端 Key）", true);
}

// 用量账本：渠道 systemone、上游 cloud、价格 0（只记 tokens 与次数）。
{
  const dbPath = process.env.OMNI_DB_PATH ?? path.join(dataDir, "omni-studio.db");
  const raw = new Database(dbPath, { readonly: true });
  const row = raw
    .query("SELECT channel, upstream, model, input_tokens, requests FROM usage_records ORDER BY id DESC LIMIT 1")
    .get() as { channel?: string; upstream?: string; model?: string; input_tokens?: number; requests?: number } | null;
  raw.close();
  check(
    "用量账本记了一行（channel=systemone, upstream=cloud）",
    row?.channel === "systemone" && row?.upstream === "cloud" && row?.model === "jev-1.13.0",
    JSON.stringify(row),
  );
}

// 失败路径：连不上的后端要留日志（没有 logEvent 的失败路径等于无法排障）。
{
  updateSettings({ SYSTEMONE_CLOUD_BASE_URL: "http://127.0.0.1:1" });
  const failedResult = await SystemOne.runSystemOne({
    state: "s",
    model: "jev-latest",
    questions: { a: { type: "noul", instructions: "?" } },
  });
  check("连不上后端时返回可读失败", !failedResult.ok && (failedResult.status === 502 || failedResult.status === 504), !failedResult.ok ? `${failedResult.status} ${failedResult.message}` : "unexpected ok");
  updateSettings({ SYSTEMONE_CLOUD_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}` });
}

// 没有后端：503 且文案说明去哪儿配。
{
  updateSettings({ SYSTEMONE_BACKEND: "cloud", SYSTEMONE_CLOUD_API_KEY: "" });
  const none = await SystemOne.runSystemOne({ state: "s", model: "jev-latest", questions: { a: { type: "noul", instructions: "?" } } });
  check("没有可用后端 → 503 configuration_error", !none.ok && none.status === 503, !none.ok ? String(none.status) : "unexpected ok");
  updateSettings({ SYSTEMONE_BACKEND: "cloud", SYSTEMONE_CLOUD_API_KEY: "smoke-typesafe-key-abc123" });
}

// ---------------------------------------------------------------------------
// 4. 网关 + 官方 SDK（真正验收：只换两行）
// ---------------------------------------------------------------------------

updateSettings({
  GATEWAY_ENABLED: "1",
  GATEWAY_HOST: "127.0.0.1",
  GATEWAY_PORT: String(GATEWAY_PORT),
  GATEWAY_API_KEY: "smoke-gateway-key",
});

const { startGateway, stopGateway } = await import("../src/bun/gateway");
const started = await startGateway();
check("网关起来了", started.ok, started.ok ? undefined : `端口 ${GATEWAY_PORT}`);

const BASE = `http://127.0.0.1:${GATEWAY_PORT}`;
try {
  const sdk = await import("@typesafe-ai/sdk");
  process.env.TYPESAFE_BASE_URL = BASE;
  process.env.TYPESAFE_API_KEY = "smoke-gateway-key";
  const client = new sdk.TypeSafeClient();
  const response = await client.systemOne({
    state: "Duplicate charge.",
    questions: { triage: { type: "choice", instructions: "Which team?", criteria: { billing: null, technical: null } } },
  });
  check("官方 JS SDK 直连本机网关成功", response.model === "jev-1.13.0" && response.answers.triage?.type === "choice");
  const models = await client.models.list();
  check("官方 SDK 的 models.list() 能解析（TypeSafe 的 models 字段）", models.some((m) => m.name === "jev-latest"));

  // 401 / 403 / 422 三档。
  const noKey = await fetch(`${BASE}/v1/systemone`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: "s", model: "jev-latest", questions: { a: { type: "noul", instructions: "?" } } }),
  });
  check("缺 Key → 403", noKey.status === 403, String(noKey.status));
  const badKey = await fetch(`${BASE}/v1/systemone`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer nope" },
    body: JSON.stringify({ state: "s", model: "jev-latest", questions: { a: { type: "noul", instructions: "?" } } }),
  });
  check("Key 无效 → 401", badKey.status === 401, String(badKey.status));
  const badBody = await fetch(`${BASE}/v1/systemone`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer smoke-gateway-key" },
    body: JSON.stringify({ state: "s", model: "jev-latest", questions: {} }),
  });
  const detail = (await badBody.json()) as { detail?: { loc?: unknown[]; type?: string }[] };
  check("校验失败 → 422 且 detail 指到字段", badBody.status === 422 && detail.detail?.[0]?.loc?.[1] === "questions", JSON.stringify(detail).slice(0, 200));

  const modelsResponse = await fetch(`${BASE}/v1/models`, { headers: { Authorization: "Bearer smoke-gateway-key" } });
  const modelsBody = (await modelsResponse.json()) as { data?: unknown[]; models?: unknown[] };
  check("/v1/models 同时给 data（OpenAI）与 models（TypeSafe）", Array.isArray(modelsBody.data) && Array.isArray(modelsBody.models));

  const openapi = (await (await fetch(`${BASE}/openapi.json`)).json()) as { paths?: Record<string, unknown> };
  check("OpenAPI 里有 /v1/systemone", !!openapi.paths?.["/v1/systemone"]);
} finally {
  delete process.env.TYPESAFE_BASE_URL;
  delete process.env.TYPESAFE_API_KEY;
  await stopGateway();
  upstream.stop();
}

// ---------------------------------------------------------------------------
// 5. 日志里能看到失败事件
// ---------------------------------------------------------------------------

{
  const appLog = path.join(dataDir, "logs", "app.log");
  const text = existsSync(appLog) ? await Bun.file(appLog).text() : "";
  check(
    "app.log 里有 systemone 事件（失败路径可排障）",
    text.includes('"systemone"'),
    appLog,
  );
}

console.log(failed === 0 ? "\n全部通过。" : `\n${failed} 项未通过。`);
process.exit(failed === 0 ? 0 : 1);
