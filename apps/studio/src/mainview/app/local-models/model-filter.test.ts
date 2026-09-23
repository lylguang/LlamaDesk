import { describe, expect, test } from "bun:test";
import { filterModels, type PickerModel } from "./model-filter";

const model = (fileName: string, repo = "org/repo", isActive = false): PickerModel => ({
  fileName,
  repo,
  path: `/models/${fileName}`,
  kind: fileName.endsWith(".gguf") ? "gguf" : "safetensors",
  isActive,
});

const LIST: PickerModel[] = [
  model("Qwen3.5-0.8B", "Qwen/Qwen3.5-0.8B"),
  model("K2-Horizon-7B-Q4_0.gguf", "NANI-Nithin/K2-Horizon-7B-GGUF", true),
  model("Qwen3.8-27B-4bit-MTP-MLX", "rapid-mlx/Qwen3.8-27B-4bit-MTP-MLX"),
  model("Qwen3.10-4B", "Qwen/Qwen3.10-4B"),
];

describe("filterModels", () => {
  test("空词：当前模型置顶，其余按名字自然序", () => {
    expect(filterModels(LIST, "").map((m) => m.fileName)).toEqual([
      "K2-Horizon-7B-Q4_0.gguf",
      "Qwen3.5-0.8B",
      "Qwen3.8-27B-4bit-MTP-MLX",
      "Qwen3.10-4B",
    ]);
  });

  test("按模型名筛选，不区分大小写", () => {
    expect(filterModels(LIST, "qwen3.8").map((m) => m.fileName)).toEqual([
      "Qwen3.8-27B-4bit-MTP-MLX",
    ]);
  });

  test("多个词都要命中（名字 + 量化/精度）", () => {
    expect(filterModels(LIST, "qwen 4bit").map((m) => m.fileName)).toEqual([
      "Qwen3.8-27B-4bit-MTP-MLX",
    ]);
  });

  test("名字没命中时按仓库名兜底（找「从哪下的」）", () => {
    expect(filterModels(LIST, "nani-nithin").map((m) => m.fileName)).toEqual([
      "K2-Horizon-7B-Q4_0.gguf",
    ]);
  });

  test("前缀命中排在包含命中之前", () => {
    const hit = filterModels([model("x-Qwen3", "a/b"), model("Qwen3-x", "a/b")], "qwen3");
    expect(hit.map((m) => m.fileName)).toEqual(["Qwen3-x", "x-Qwen3"]);
  });

  test("无结果时返回空数组（界面给「没有匹配的模型」）", () => {
    expect(filterModels(LIST, "llama")).toEqual([]);
  });

  test("不改动入参", () => {
    const copy = [...LIST];
    filterModels(LIST, "");
    expect(LIST).toEqual(copy);
  });
});
