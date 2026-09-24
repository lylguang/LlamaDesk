/**
 * 上下文窗口解析（`chat-context.ts`）的单测。
 *
 * 钉住的取舍：
 *   1. 云端模式**不读** `SERVER_CTX_SIZE` —— 那是 llama.cpp 的 KV 旋钮，
 *      沿用它会把 128k 窗口的云端模型当 8k 算，max_tokens 被钳到 1
 *      （2026-09 MiniMax-M3 云端空回合事故）；
 *   2. 云端窗口按模型定：**用户手填的覆盖值** → id 尺寸后缀 → 已知型号目录
 *      → 256K 兜底（值是 1M 的型号不再被按 128K 压缩）；
 *   3. 本地模式行为与旧版完全一致（`SERVER_CTX_SIZE || 8192`）。
 */
import { describe, expect, test } from "bun:test";

import { mockModulePartial } from "./test-mocks";

const SETTINGS: Record<string, string> = {};

await mockModulePartial<typeof import("./db/settings")>("./db/settings", {
  getSetting: (key) => SETTINGS[key] ?? "",
  getNumericSetting: (key) => Number(SETTINGS[key] ?? 0) || 0,
  updateSettings: (values) => Object.assign(SETTINGS, values),
  getAllSettings: () => ({ ...SETTINGS }),
});

const { chatContextWindow, contextWindowFromModelId } = await import("./chat-context");

describe("contextWindowFromModelId", () => {
  test("认得出常见尺寸后缀（k / m，含中缀与结尾位置）", () => {
    expect(contextWindowFromModelId("moonshot-v1-8k")).toBe(8 * 1024);
    expect(contextWindowFromModelId("doubao-1-5-pro-32k-250115")).toBe(32 * 1024);
    expect(contextWindowFromModelId("ernie-4.5-turbo-128k")).toBe(128 * 1024);
    expect(contextWindowFromModelId("qwen3-next-80k-a3b")).toBe(80 * 1024);
    expect(contextWindowFromModelId("some-model-1m")).toBe(1_048_576);
  });

  test("没有尺寸后缀的 id 返回 undefined（交给目录 / 兜底，不瞎猜）", () => {
    expect(contextWindowFromModelId("MiniMax-M3")).toBeUndefined();
    expect(contextWindowFromModelId("deepseek-chat")).toBeUndefined();
    expect(contextWindowFromModelId("glm-4.5")).toBeUndefined();
  });

  test("日期类数字段不误判（250414 不是尺寸）", () => {
    expect(contextWindowFromModelId("glm-4-flash-250414")).toBeUndefined();
    expect(contextWindowFromModelId("doubao-seed-1-6-250618")).toBeUndefined();
  });

  test("异常输入不给窗口（空串 / 离谱数字）", () => {
    expect(contextWindowFromModelId("")).toBeUndefined();
    expect(contextWindowFromModelId("model-99999999k")).toBeUndefined();
  });
});

describe("chatContextWindow", () => {
  test("本地模式沿用引擎旋钮，缺省 8192（与旧行为一致）", () => {
    SETTINGS.SERVER_MODE = "local";
    delete SETTINGS.SERVER_CTX_SIZE;
    expect(chatContextWindow()).toBe(8192);
    SETTINGS.SERVER_CTX_SIZE = "32768";
    expect(chatContextWindow()).toBe(32768);
    SETTINGS.SERVER_CTX_SIZE = "not-a-number";
    expect(chatContextWindow()).toBe(8192);
  });

  test("云端模式无视引擎旋钮：id 带尺寸按 id，认不出的走 256K 兜底", () => {
    SETTINGS.SERVER_MODE = "remote";
    // 引擎旋钮即便被设过也不串门 —— 它只管本地 KV 分配。
    SETTINGS.SERVER_CTX_SIZE = "8192";
    SETTINGS.CLOUD_MODELS = "[]";
    SETTINGS.VLLM_MODEL_NAME = "MiniMax-M3";
    expect(chatContextWindow()).toBe(262_144);
    SETTINGS.VLLM_MODEL_NAME = "moonshot-v1-8k";
    expect(chatContextWindow()).toBe(8 * 1024);
  });

  test("云端模式：已知型号走目录（1M 档不会被按 128K 算）", () => {
    SETTINGS.SERVER_MODE = "remote";
    SETTINGS.CLOUD_MODELS = "[]";
    SETTINGS.VLLM_MODEL_NAME = "gemini-2.5-pro";
    expect(chatContextWindow()).toBe(1_048_576);
    SETTINGS.VLLM_MODEL_NAME = "deepseek-chat";
    expect(chatContextWindow()).toBe(131_072);
  });

  test("云端模式：设置页手填的覆盖值优先于一切自动判断", () => {
    SETTINGS.SERVER_MODE = "remote";
    SETTINGS.VLLM_MODEL_NAME = "deepseek-chat"; // 目录里是 128K
    SETTINGS.CLOUD_MODELS = JSON.stringify([
      { id: "deepseek-chat", contextLength: 1_048_576 },
      { id: "bad-model", contextLength: 0 }, // 非法值：当没填（目录/兜底接手）
    ]);
    expect(chatContextWindow()).toBe(1_048_576);

    // 覆盖值写的是别的模型：当前模型仍按目录走。
    SETTINGS.VLLM_MODEL_NAME = "glm-4.5";
    expect(chatContextWindow()).toBe(131_072);

    // 清掉覆盖值 → 回到自动判断。
    SETTINGS.CLOUD_MODELS = "[]";
    expect(chatContextWindow()).toBe(131_072);
    SETTINGS.VLLM_MODEL_NAME = "deepseek-chat";
    SETTINGS.CLOUD_MODELS = JSON.stringify([{ id: "deepseek-chat" }]);
    expect(chatContextWindow()).toBe(131_072);
  });

  test("SERVER_MODE 未设置时按云端处理（远端是推理服务的默认形态）", () => {
    delete SETTINGS.SERVER_MODE;
    SETTINGS.VLLM_MODEL_NAME = "MiniMax-M3";
    SETTINGS.CLOUD_MODELS = "[]";
    delete SETTINGS.SERVER_CTX_SIZE;
    expect(chatContextWindow()).toBe(262_144);
  });
});
