import { afterAll, expect, mock, setSystemTime, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { join } from "path";
import * as fs from "fs";

import * as schema from "./db/schema";
import type { CloudProviderInfo } from "../shared/cloud-providers";
import { mockModulePartial } from "./test-mocks";

// ---------------------------------------------------------------------------
// 独立的临时测试库（跑迁移，得到真实的 video_records / usage_records 表）
// ---------------------------------------------------------------------------
const tmpDb = `/tmp/video-gen-test-${process.pid}.db`;
fs.rmSync(tmpDb, { force: true });
const sqlite = new Database(tmpDb, { create: true });
const db = drizzle({ client: sqlite, schema });
migrate(db, { migrationsFolder: join(import.meta.dir, "db/migrations") });

const IMAGES = `/tmp/video-gen-images-${process.pid}`;

await mockModulePartial<typeof import("./db")>("./db", { db });
await mockModulePartial<typeof import("./db/settings")>("./db/settings", {
  getSetting: () => "",
  updateSettings: () => {},
});
await mockModulePartial<typeof import("./image-server")>("./image-server", {
  getImagesBaseDir: () => IMAGES,
});
await mockModulePartial<typeof import("../shared/server-info")>("../shared/server-info", {
  chatImageUrl: (ref: string) => `http://img.local/${ref}`,
});

/**
 * 云端厂商替身：地址**故意带 `/v1`** —— 用户常把接口文档里带版本的整段路径
 * 一起填进「API 地址」，这里就是那次 `…/v1/v2/video_generation` 404 的现场。
 */
const PROVIDER: CloudProviderInfo = {
  id: "minimax",
  name: "MiniMax",
  vendor: "MiniMax",
  baseUrl: "https://api.minimax.chat/v1",
  apiKey: "sk-test",
  models: [],
  enabled: true,
  videoApi: "minimax",
  musicApi: "",
  createdAt: 0,
  updatedAt: 0,
};

await mockModulePartial<typeof import("./cloud-providers")>("./cloud-providers", {
  resolveCloudProvider: (id) => ((id ?? "").trim() === PROVIDER.id ? { ...PROVIDER } : null),
  saveAppModelChoice: () => ({ ok: true }),
});

const { clampMinimaxDuration, normalizeApiBase, pollVideoRecords, submitVideoGeneration } =
  await import("./video-gen");
const { readAppLogsInMemory } = await import("./app-log");

// ---------------------------------------------------------------------------
// 上游 fetch 替身：每个用例自己决定返回什么
// ---------------------------------------------------------------------------
type Reply = { status: number; body?: string; bytes?: Uint8Array<ArrayBuffer> };
let reply: (url: string) => Reply;
const seenUrls: string[] = [];
/** 最近一次 POST 的请求体（断言请求形状用）。 */
let lastBody: Record<string, unknown> | null = null;

const originalFetch = globalThis.fetch;
globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  seenUrls.push(url);
  lastBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
  const r = reply(url);
  return r.bytes
    ? new Response(r.bytes, { status: r.status })
    : new Response(r.body ?? "", { status: r.status });
}) as unknown as typeof fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
  sqlite.close();
  fs.rmSync(tmpDb, { force: true });
  fs.rmSync(IMAGES, { recursive: true, force: true });
});

/** v2 提交成功：HTTP 200 + task_id。 */
function minimaxOk(extra: Record<string, unknown>): string {
  return JSON.stringify({ task_id: "task-1", ...extra });
}

/** v2 查询响应：任务包在 `task` 里（status + content.url）。 */
function minimaxTask(extra: Record<string, unknown>): string {
  return JSON.stringify({ task: { status: "running", ...extra } });
}

/** v2 错误信封：OpenAI 风格，配 4xx/5xx 的 HTTP 状态。 */
function minimaxError(message: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "error", error: { type: "invalid_request_error", message, ...over } });
}

function seedProcessing(over: Partial<typeof schema.videoRecords.$inferInsert> = {}) {
  return db
    .insert(schema.videoRecords)
    .values({
      status: "processing",
      backend: "cloud",
      providerId: PROVIDER.id,
      model: "MiniMax-H3",
      taskId: "task-1",
      prompt: "两只猫在居酒屋",
      createdAt: Date.now(),
      ...over,
    })
    .returning()
    .get();
}

/** 某事件下、与给定关键字（如 taskId）匹配的最近一条日志；内存日志默认最新在前。 */
function lastLog(event: string, needle: string) {
  const hit = readAppLogsInMemory({ event }).find((e) => JSON.stringify(e).includes(needle));
  return hit ? JSON.stringify(hit) : "";
}

/** 轮询单条记录并取出结果（列表里必然有这一条）。 */
async function pollOne(id: number) {
  const [row] = await pollVideoRecords([id]);
  return row!;
}

/** 把假时钟往前拨一段时间再跑一段逻辑，跑完恢复真实时间。 */
async function withClockAdvanced<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  setSystemTime(Date.now() + ms);
  try {
    return await fn();
  } finally {
    setSystemTime();
  }
}

type SubmitArgs = Parameters<typeof submitVideoGeneration>[0];

function submitMiniMax(model = "MiniMax-H3", over: Partial<SubmitArgs> = {}) {
  return submitVideoGeneration({
    prompt: "两只猫在居酒屋",
    duration: 5,
    ratio: "16:9",
    resolution: "768P",
    config: { backend: "cloud", providerId: PROVIDER.id, model },
    ...over,
  });
}

// ---------------------------------------------------------------------------
// 地址归一化 / 档位
// ---------------------------------------------------------------------------

test("normalizeApiBase：剥掉误填的 /v1、/v2、/api/v3", () => {
  expect(normalizeApiBase("https://api.minimax.chat/v1", "")).toBe("https://api.minimax.chat");
  expect(normalizeApiBase("https://api.minimax.chat/v2/", "")).toBe("https://api.minimax.chat");
  expect(normalizeApiBase("https://api.minimax.chat/", "")).toBe("https://api.minimax.chat");
  expect(normalizeApiBase("https://api.minimax.chat", "")).toBe("https://api.minimax.chat");
  // 自部署兼容服务：路径里的版本段只在末尾，前面的路径要留着
  expect(normalizeApiBase("http://host/minimax/v2", "")).toBe("http://host/minimax");
  // Seedance：协议前缀是 /api/v3，三种写法都归一到同一个地址
  expect(normalizeApiBase("https://ark.cn-beijing.volces.com", "/api/v3")).toBe(
    "https://ark.cn-beijing.volces.com/api/v3",
  );
  expect(normalizeApiBase("https://ark.cn-beijing.volces.com/api/v3", "/api/v3")).toBe(
    "https://ark.cn-beijing.volces.com/api/v3",
  );
  expect(normalizeApiBase("  ", "")).toBe("");
});

test("时长收敛到各模型的区间（H3 4~15 秒、H3-Max 5~15 秒）", () => {
  expect(clampMinimaxDuration(5, "MiniMax-H3")).toBe(5);
  expect(clampMinimaxDuration(2, "MiniMax-H3")).toBe(4);
  expect(clampMinimaxDuration(20, "MiniMax-H3")).toBe(15);
  // H3-Max 的下限是 5：4 秒会被抬上来
  expect(clampMinimaxDuration(4, "MiniMax-H3-Max")).toBe(5);
  expect(clampMinimaxDuration(20, "MiniMax-H3-Max")).toBe(15);
  // 没给时长 / 认不出的模型：落到 H3 系的默认档与协议区间
  expect(clampMinimaxDuration(undefined, "MiniMax-H3")).toBe(5);
  expect(clampMinimaxDuration(undefined)).toBe(5);
  expect(clampMinimaxDuration(99, "some-relay-h3")).toBe(15);
});

// ---------------------------------------------------------------------------
// 提交（v2 契约）
// ---------------------------------------------------------------------------

test("提交走 v2：/v2/video_generation + content 数组；地址带 /v1 也不会重复", async () => {
  seenUrls.length = 0;
  reply = () => ({ status: 200, body: minimaxOk({}) });

  const res = await submitMiniMax();
  expect(res.error).toBeUndefined();
  expect(res.record?.status).toBe("processing");
  expect(res.record?.taskId).toBe("task-1");
  expect(seenUrls).toEqual(["https://api.minimax.chat/v2/video_generation"]);
  expect(lastBody?.model).toBe("MiniMax-H3");
  expect(lastBody?.content).toEqual([{ type: "text", text: "两只猫在居酒屋" }]);
  expect(lastBody?.duration).toBe(5);
  expect(lastBody?.resolution).toBe("768P");
  expect(lastBody?.ratio).toBe("16:9");
  // v1 的形状不该再出现：prompt 字符串 / first_frame_image 都是旧接口的字段
  expect(lastBody?.prompt).toBeUndefined();
  expect(lastBody?.first_frame_image).toBeUndefined();
});

test("提交：分辨率和时长按模型收敛后再发（H3-Max 选 2K / 4 秒 → 768P / 5 秒）", async () => {
  reply = () => ({ status: 200, body: minimaxOk({}) });

  const res = await submitMiniMax("MiniMax-H3-Max", { duration: 4, resolution: "2K" });
  expect(res.error).toBeUndefined();
  expect(lastBody?.model).toBe("MiniMax-H3-Max");
  expect(lastBody?.resolution).toBe("768P");
  expect(lastBody?.duration).toBe(5);
  // 库里记的也是收敛后的值（卡片上写的必须与上游生成的一致）
  expect(res.record?.resolution).toBe("768P");
  expect(res.record?.duration).toBe(5);
});

test("提交：首帧图按 v2 的形状放进 content（image_url 是对象，带 role）", async () => {
  fs.mkdirSync(join(IMAGES, "chat"), { recursive: true });
  fs.writeFileSync(join(IMAGES, "chat", "frame.png"), Buffer.from([1, 2, 3]));
  reply = () => ({ status: 200, body: minimaxOk({}) });

  const res = await submitMiniMax("MiniMax-H3", { firstFrameRef: "chat/frame.png" });
  expect(res.error).toBeUndefined();
  expect(lastBody?.content).toEqual([
    { type: "text", text: "两只猫在居酒屋" },
    {
      type: "image_url",
      image_url: { url: "data:image/png;base64,AQID" },
      role: "first_frame",
    },
  ]);
  expect(res.record?.firstFrameUrl).toBe("http://img.local/chat/frame.png");
});

test("提交撞上 4xx 错误信封：把上游原话与 HTTP 状态一起报出来", async () => {
  reply = () => ({
    status: 401,
    body: minimaxError("invalid api key", { http_code: 401 }),
  });
  const res = await submitMiniMax();
  expect(res.error).toContain("invalid api key");
  expect(res.error).toContain("HTTP 401");
});

test("提交撞上 200 + HTML（中转站首页）：直说是网页而不是接口", async () => {
  reply = () => ({
    status: 200,
    body: "<!doctype html><html><head><title>网关</title></head></html>",
  });
  const res = await submitMiniMax();
  expect(res.error).toContain("网页");
  // 指路要指到模型库的云端模型页签（原「模型云服务」，2026-09 收进模型库）
  expect(res.error).toContain("云端模型");
});

test("提交：路由不存在时，报错要说清这地址不是 MiniMax v2 视频服务", async () => {
  reply = () => ({ status: 404, body: "404 page not found" });
  const res = await submitMiniMax();
  expect(res.error).toContain("MiniMax v2 视频接口");
  expect(res.error).toContain("/v2/video_generation");
  expect(res.error).toContain("云端模型");
});

// ---------------------------------------------------------------------------
// 轮询
// ---------------------------------------------------------------------------

test("轮询成功：直接取 task.content.url 下载落盘（不再有 files/retrieve 换链）", async () => {
  const seeded = seedProcessing({ taskId: "task-ok" });
  seenUrls.length = 0;
  reply = (url) =>
    url.includes("/query/video_generation")
      ? {
          status: 200,
          body: minimaxTask({ status: "succeeded", content: { url: "https://cdn.example/abc.mp4" } }),
        }
      : { status: 200, bytes: new Uint8Array([1, 2, 3, 4]) };

  const row = await pollOne(seeded.id);
  expect(row.status).toBe("done");
  expect(row.videoPath).toMatch(/^videos\/.+\.mp4$/);
  expect(row.videoUrl).toBe(`http://img.local/${row.videoPath}`);
  expect(seenUrls).toEqual([
    "https://api.minimax.chat/v2/query/video_generation/task-ok",
    "https://cdn.example/abc.mp4",
  ]);
});

test("轮询：queued / running 都算在跑，保持 processing", async () => {
  const seeded = seedProcessing({ taskId: "task-running" });
  reply = () => ({ status: 200, body: minimaxTask({ status: "queued" }) });

  const row = await pollOne(seeded.id);
  expect(row.status).toBe("processing");
  expect(row.pollError).toBeFalsy();
});

test("轮询：任务失败时把 task.error 的码与原话透出来", async () => {
  const seeded = seedProcessing({ taskId: "task-failed" });
  reply = () => ({
    status: 200,
    body: minimaxTask({
      status: "failed",
      error: { code: 2013, message: "invalid params" },
    }),
  });

  const row = await pollOne(seeded.id);
  expect(row.status).toBe("failed");
  expect(row.error).toContain("2013");
  expect(row.error).toContain("invalid params");
});

test("轮询遇 401：宽限期内亮出原因，过期才标失败", async () => {
  const seeded = seedProcessing({ taskId: "task-401" });
  reply = () => ({ status: 401, body: minimaxError("invalid api key") });

  const first = await pollOne(seeded.id);
  expect(first.status).toBe("processing");
  expect(first.pollError).toContain("401");
  expect(first.pollError).toContain("API Key");
  expect(lastLog("video.poll.http", "task-401")).toContain('"level":"error"');

  const late = await withClockAdvanced(4 * 60_000, () => pollOne(seeded.id));
  expect(late.status).toBe("failed");
  expect(late.error).toContain("401");
  expect(lastLog("video.poll.failed", "task-401")).toContain("task-401");
});

test("轮询遇 5xx：保留 processing，把原因透到界面并记 warn 日志", async () => {
  const seeded = seedProcessing({ taskId: "task-503" });
  reply = () => ({ status: 503, body: "service unavailable" });

  const row = await pollOne(seeded.id);
  expect(row.status).toBe("processing");
  expect(row.pollError).toContain("503");
  expect(lastLog("video.poll.http", "task-503")).toContain('"level":"warn"');
});

test("轮询：查询路径不存在时指向「地址不对」，并给宽限期", async () => {
  const seeded = seedProcessing({ taskId: "task-404" });
  reply = () => ({ status: 404, body: "404 page not found" });

  const first = await pollOne(seeded.id);
  expect(first.status).toBe("processing");
  expect(first.pollError).toContain("/v2/query/video_generation/");
  expect(first.pollError).toContain("https://api.minimax.chat");

  const late = await withClockAdvanced(4 * 60_000, () => pollOne(seeded.id));
  expect(late.status).toBe("failed");
});

test("轮询：上游说任务没了（JSON 404）是终态，立刻失败而不是等超时", async () => {
  const seeded = seedProcessing({ taskId: "task-notfound" });
  reply = () => ({
    status: 404,
    body: minimaxError("task not found", { http_code: 404 }),
  });

  const row = await pollOne(seeded.id);
  expect(row.status).toBe("failed");
  expect(row.error).toContain("任务不存在");
});

test("轮询一次只打一个上游地址；已完成的记录不再轮询", async () => {
  const seeded = seedProcessing({ taskId: "task-once" });
  seenUrls.length = 0;
  reply = (url) =>
    url.includes("/query/video_generation")
      ? {
          status: 200,
          body: minimaxTask({ status: "succeeded", content: { url: "https://cdn.example/one.mp4" } }),
        }
      : { status: 200, bytes: new Uint8Array([1, 2, 3, 4]) };

  const row = await pollOne(seeded.id);
  expect(row.status).toBe("done");
  expect(seenUrls[0]).toBe("https://api.minimax.chat/v2/query/video_generation/task-once");

  seenUrls.length = 0;
  const again = await pollOne(seeded.id);
  expect(again.status).toBe("done");
  expect(seenUrls.length).toBe(0); // 已是终态：不再打上游
});

test("记录里的厂商已被删除：直接失败，不拖到 30 分钟超时", async () => {
  const seeded = seedProcessing({ providerId: "gone-provider", taskId: "task-gone-provider" });
  reply = () => ({ status: 200, body: minimaxTask({}) });

  const row = await pollOne(seeded.id);
  expect(row.status).toBe("failed");
  expect(row.error).toContain("无法继续查询上游状态");
});
