/**
 * 云模型上下文窗口解析（`shared/model-context.ts`）的单测。
 *
 * 这个模块是「用户看到的窗口」和「Agent 压缩按的窗口」的唯一真源，
 * 所以把优先级与边界钉死：覆盖值 → id 后缀 → 名字目录 → 256K 兜底。
 */
import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MODEL_CONTEXT,
  catalogContextWindow,
  formatContextWindow,
  parseContextWindowInput,
  resolveCloudContextWindow,
} from "./model-context";

describe("resolveCloudContextWindow", () => {
  test("用户覆盖值优先于后缀与目录", () => {
    expect(resolveCloudContextWindow("moonshot-v1-8k", 1_048_576)).toBe(1_048_576);
    expect(resolveCloudContextWindow("deepseek-chat", 32_768)).toBe(32_768);
  });

  test("非法覆盖值当没填（继续自动判断），而不是崩成 0", () => {
    expect(resolveCloudContextWindow("deepseek-chat", 0)).toBe(131_072);
    expect(resolveCloudContextWindow("deepseek-chat", -1)).toBe(131_072);
    expect(resolveCloudContextWindow("deepseek-chat", Number.NaN)).toBe(131_072);
    expect(resolveCloudContextWindow("deepseek-chat", 999_999_999)).toBe(131_072);
  });

  test("id 后缀比名字目录更可信（先认后缀）", () => {
    // 目录里 doubao-seed 是 256K，但这个 id 自带 -32k
    expect(resolveCloudContextWindow("doubao-seed-1-6-32k")).toBe(32 * 1024);
  });

  test("认不出的型号走 256K 兜底（空 id 也一样）", () => {
    expect(resolveCloudContextWindow("some-random-model")).toBe(DEFAULT_MODEL_CONTEXT);
    expect(resolveCloudContextWindow("")).toBe(DEFAULT_MODEL_CONTEXT);
  });

  test("目录覆盖常见厂商的窗口档位", () => {
    expect(resolveCloudContextWindow("gemini-2.5-pro")).toBe(1_048_576);
    expect(resolveCloudContextWindow("MiniMax-M1")).toBe(1_048_576);
    expect(resolveCloudContextWindow("anthropic/claude-sonnet-4")).toBe(204_800);
    expect(resolveCloudContextWindow("deepseek-ai/DeepSeek-V3")).toBe(131_072);
    // DeepSeek 官方是 128K，不是 1M：猜大会让压缩线抬到 600K 后稳定 400。
    expect(catalogContextWindow("deepseek-chat")).toBe(131_072);
  });
});

describe("formatContextWindow", () => {
  test("按 K / M 显示（1024 的整数倍）", () => {
    expect(formatContextWindow(262_144)).toBe("256K");
    expect(formatContextWindow(1_048_576)).toBe("1M");
    expect(formatContextWindow(131_072)).toBe("128K");
    expect(formatContextWindow(32_768)).toBe("32K");
  });

  test("非整数倍的照原样显示，坏值给空串", () => {
    expect(formatContextWindow(200_000)).toBe("200000");
    expect(formatContextWindow(0)).toBe("");
    expect(formatContextWindow(Number.NaN)).toBe("");
  });
});

describe("parseContextWindowInput", () => {
  test("认 k / m 后缀与纯数字", () => {
    expect(parseContextWindowInput("256k")).toBe(262_144);
    expect(parseContextWindowInput("1M")).toBe(1_048_576);
    expect(parseContextWindowInput("131072")).toBe(131_072);
    expect(parseContextWindowInput(" 128 K ")).toBe(131_072);
  });

  test("空串 / 认不出 / 越界 → undefined（= 清空覆盖，回到自动）", () => {
    expect(parseContextWindowInput("")).toBeUndefined();
    expect(parseContextWindowInput("abc")).toBeUndefined();
    expect(parseContextWindowInput("0")).toBeUndefined();
    expect(parseContextWindowInput("99999m")).toBeUndefined();
  });
});
