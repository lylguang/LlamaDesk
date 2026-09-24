/**
 * 云模型条目里「上下文窗口覆盖值」的解析与读取（`shared/cloud-providers.ts`）。
 *
 * 这个值同时被三处读：设置页显示、对话 / Agent 的压缩预算、`omi launch` 写进
 * Codex / ChatGPT 目录。所以钉住两件事：
 *   1. 读入口径一致（`contextLengthForModel` 就是运行时与 CLI 共用的那个查找）；
 *   2. 坏值一律当没填 —— 它在 bun 侧直接决定压缩预算，也决定外部工具何时压缩。
 */
import { describe, expect, test } from "bun:test";

import { contextLengthForModel, modelContextOf, parseCloudModels } from "./cloud-providers";

describe("contextLengthForModel", () => {
  test("取到该模型手填的覆盖值；别的模型 / 没填 / 不是 JSON 都不给值", () => {
    const json = JSON.stringify([{ id: "deepseek-chat", contextLength: 1_048_576 }, { id: "other" }]);
    expect(contextLengthForModel(json, "deepseek-chat")).toBe(1_048_576);
    // 没填覆盖值的条目 → undefined（调用方继续走后缀 / 目录 / 兜底）
    expect(contextLengthForModel(json, "other")).toBeUndefined();
    expect(contextLengthForModel(json, "missing")).toBeUndefined();
    expect(contextLengthForModel("", "deepseek-chat")).toBeUndefined();
    expect(contextLengthForModel(undefined, "deepseek-chat")).toBeUndefined();
    expect(contextLengthForModel(json, "")).toBeUndefined();
  });

  test("坏值当没填，不会把 0 / 负数 / 越界值交出去", () => {
    const json = JSON.stringify([
      { id: "a", contextLength: 0 },
      { id: "b", contextLength: -1 },
      { id: "c", contextLength: 999_999_999 },
      { id: "d", contextLength: "256k" },
    ]);
    for (const id of ["a", "b", "c", "d"]) {
      expect(contextLengthForModel(json, id)).toBeUndefined();
    }
  });
});

describe("parseCloudModels 保留覆盖值", () => {
  test("合法值原样带出，非法值被摘掉（旧数据 / 手滑都走这条路）", () => {
    const parsed = parseCloudModels(
      JSON.stringify([{ id: "a", contextLength: 262_144 }, { id: "b", contextLength: 0 }]),
    );
    expect(parsed[0]).toEqual({ id: "a", contextLength: 262_144 });
    // contextLength 被剔除后只剩 id（其余可选字段本来就是 undefined）
    expect(parsed[1]!.id).toBe("b");
    expect(parsed[1]!.contextLength).toBeUndefined();
  });
});

describe("modelContextOf", () => {
  test("覆盖值优先，否则按 id 自动判断（与运行时同一个解析器）", () => {
    expect(modelContextOf({ id: "moonshot-v1-8k", contextLength: 131_072 })).toBe(131_072);
    expect(modelContextOf({ id: "moonshot-v1-8k" })).toBe(8 * 1024);
    expect(modelContextOf({ id: "gemini-2.5-pro" })).toBe(1_048_576);
    expect(modelContextOf({ id: "unknown-model" })).toBe(262_144);
  });
});
