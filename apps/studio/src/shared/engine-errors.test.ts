import { describe, expect, test } from "bun:test";

import {
  classifyStartupError,
  isModelSideFailure,
  STARTUP_ERROR_KINDS,
  TEXT_DERIVABLE_KINDS,
} from "./engine-errors";

/** 全部类型都必须能由某个真实错误文本认出来，否则规则表里那条是死的。 */
const CASES: { kind: (typeof STARTUP_ERROR_KINDS)[number]; text: string }[] = [
  // 缺依赖
  { kind: "missing-dependency", text: "ModuleNotFoundError: No module named 'mlx_lm'" },
  { kind: "missing-dependency", text: "sh: 1: vllm: command not found" },
  { kind: "missing-dependency", text: "ImportError: libcudart.so.12: cannot open shared object file" },
  { kind: "missing-dependency", text: "vLLM is not installed. Please install it with pip install vllm" },
  // 显存
  { kind: "vram-insufficient", text: "torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB" },
  { kind: "vram-insufficient", text: "ggml_metal_init: error: failed to allocate buffer" },
  { kind: "vram-insufficient", text: "CUDA error: insufficient memory for KV cache" },
  // 磁盘
  { kind: "disk-full", text: "OSError: [Errno 28] No space left on device" },
  // 端口
  { kind: "port-in-use", text: "ERROR: [Errno 98] Address already in use" },
  { kind: "port-in-use", text: "error while attempting to bind on address ('0.0.0.0', 18010): address already in use" },
  // 权重
  { kind: "model-missing", text: "llama_model_load: error loading model: failed to open ./models/qwen.gguf: No such file or directory" },
  { kind: "model-missing", text: "error loading model: unknown (bad magic)" },
  { kind: "model-missing", text: "ValueError: tensor data is incomplete, expected 4096 bytes" },
  // 模型格式
  { kind: "model-format", text: "Error: unknown model architecture: 'spark2_5'" },
  { kind: "model-format", text: "ValueError: Model type deepseek_v41 not supported." },
  { kind: "model-format", text: "failed to load model: unknown quantization type 'IQ9_XXS'" },
  // 权限
  { kind: "permission", text: "Permission denied: ./engines/llama-server" },
  { kind: "permission", text: '"llama-server" cannot be opened because the developer cannot be verified.' },
];

describe("classifyStartupError", () => {
  for (const entry of CASES) {
    test(`认得 ${entry.kind}：${entry.text.slice(0, 48)}…`, () => {
      expect(classifyStartupError(entry.text)).toBe(entry.kind);
    });
  }

  test("每个能由文本判定的类型都至少有一条用例", () => {
    const covered = new Set(CASES.map((entry) => entry.kind));
    // unknown 靠兜底产生、download-incomplete 靠上下文判定，都不在这张表里；
    // 剩下的类型如果没用例，说明规则表里那条是死的。
    expect(TEXT_DERIVABLE_KINDS.filter((kind) => !covered.has(kind))).toEqual([]);
  });

  test("下载没下完不是文本能看出来的：原文只有一句通用的加载失败", () => {
    // llama.cpp 对「文件没下完」和「架构不认识」都只说这一句，所以这条必须由
    // 调用方按上下文判定（见 model-servers.ts），不能靠猜。
    expect(classifyStartupError("llama_server: exiting due to model loading error")).toBe("unknown");
    expect(classifyStartupError("exiting due to model loading error")).not.toBe("download-incomplete");
  });

  test("认不出来就是 unknown，不硬猜", () => {
    expect(classifyStartupError("Process exited with code 1")).toBe("unknown");
    expect(classifyStartupError("")).toBe("unknown");
    expect(classifyStartupError(undefined)).toBe("unknown");
  });

  test("缺依赖优先于显存：venv 没装好时 torch 的栈里会夹着 CUDA OOM", () => {
    const text = [
      "ModuleNotFoundError: No module named 'torch'",
      "During handling of the above exception, another exception occurred:",
      "torch.OutOfMemoryError: CUDA out of memory.",
    ].join("\n");
    expect(classifyStartupError(text)).toBe("missing-dependency");
  });

  test("警告行里的错误词不算数（extractStartupError 已经滤过一轮，这里保持同一条判据）", () => {
    // 「can yield errors」是 mlx-lm 的 UserWarning，只有它自己一条时不应归到任何类型
    expect(classifyStartupError("You are using a model of type qwen3_5_moe ... can yield errors.")).toBe(
      "unknown",
    );
  });
});

describe("isModelSideFailure", () => {
  test("模型自身的问题才值得回退到备选模型", () => {
    expect(isModelSideFailure("model-format")).toBe(true);
    expect(isModelSideFailure("model-missing")).toBe(true);
    expect(isModelSideFailure("vram-insufficient")).toBe(true);
    // 配的这个还在下：换一个下完的备选正好让应用先用起来
    expect(isModelSideFailure("download-incomplete")).toBe(true);
  });

  test("端口 / 依赖 / 权限跟模型无关：换备选只会掩盖真原因", () => {
    expect(isModelSideFailure("port-in-use")).toBe(false);
    expect(isModelSideFailure("missing-dependency")).toBe(false);
    expect(isModelSideFailure("permission")).toBe(false);
    expect(isModelSideFailure("disk-full")).toBe(false);
    expect(isModelSideFailure("unknown")).toBe(false);
  });
});
