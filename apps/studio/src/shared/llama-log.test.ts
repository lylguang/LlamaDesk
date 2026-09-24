/**
 * T4e：从 llama-server 启动日志回读实测值的纯函数（shared/llama-log.ts）。
 * 只测字符串规则本身，不做任何 IO。
 */
import { describe, expect, test } from "bun:test";

import { parseComputeBufferBytes, parseFlashAttnState, parseKvCacheBytes } from "./llama-log";

const MIB = 1024 ** 2;
const GiB = 1024 ** 3;

describe("parseFlashAttnState", () => {
  test("llama_context: flash_attn = enabled → on（高 verbosity 的措辞，含多空格对齐）", () => {
    expect(parseFlashAttnState("llama_context: n_ctx                  = 65536\nllama_context: flash_attn            = enabled\n")).toBe("on");
  });

  test("llama_context: flash_attn = disabled → off", () => {
    expect(parseFlashAttnState("llama_context: flash_attn = disabled\n")).toBe("off");
  });

  test("Flash Attention not supported, set to disabled（警告级，禁用时才打）→ off", () => {
    expect(parseFlashAttnState("resolve_fused_ops: Flash Attention not supported, set to disabled\n")).toBe("off");
  });

  test("flash attention … disabled（宽松措辞，不区分大小写）→ off", () => {
    expect(parseFlashAttnState("some warning: Flash Attention is disabled for this build\n")).toBe("off");
  });

  test("无相关内容 → null（不猜）", () => {
    expect(parseFlashAttnState("llama_model_loader: - full model\nllama_context: n_ctx = 4096\n")).toBe(null);
    expect(parseFlashAttnState("")).toBe(null);
  });

  test("两种措辞同时出现时以 flash_attn = x 为准", () => {
    // enabled 最终结论 + 早期不相关警告 → on
    expect(
      parseFlashAttnState(
        "resolve_fused_ops: Flash Attention not supported, set to disabled\nllama_context: flash_attn            = enabled\n",
      ),
    ).toBe("on");
    // 反过来：警告在前、最终结论 disabled → off（两条都是 off，仍成立）
    expect(
      parseFlashAttnState(
        "llama_context: flash_attn            = disabled\nresolve_fused_ops: Flash Attention not supported, set to disabled\n",
      ),
    ).toBe("off");
  });
});

describe("parseKvCacheBytes", () => {
  test("两条 llama_kv_cache（全局 + SWA）全部相加：144 + 108 MiB",
    () => {
      const line = (n: number) => `llama_kv_cache: size = ${String(n)}.00 MiB ( n_kv  = 40960, n_batch = 2048 )`;
      const log = [line(144), line(108)].join("\n");
      expect(parseKvCacheBytes(log)).toBe(252 * MIB);
    });

  test("单位 GiB：1.5 GiB 两条 → 3 GiB", () => {
    const line = (v: string) => `llama_kv_cache: size = ${v} GiB ( n_kv = 65536 )`;
    const log = [line("1.50"), "llama_kv_cache: n_layer = 36, n_batch = 2048", line("1.5")].join("\n");
    expect(parseKvCacheBytes(log)).toBe(3 * GiB);
  });

  test("单位 MB（十进制口径按 1024² 收，与其他解析统一）：100 + 200 MB", () => {
    const line = (n: number) => `llama_kv_cache: size = ${n} MB ( n_kv = 4096 )`;
    expect(parseKvCacheBytes([line(100), line(200)].join("\n"))).toBe(300 * MIB);
  });

  test("整数小数都收：24 MiB（无小数位）", () => {
    expect(parseKvCacheBytes("llama_kv_cache: size = 24 MiB ( n_kv = 4096 )")).toBe(24 * MIB);
  });

  test("没有 → null", () => {
    expect(parseKvCacheBytes("llama_model_loader: loaded weights\n")).toBe(null);
    expect(parseKvCacheBytes("")).toBe(null);
  });
});

describe("parseComputeBufferBytes", () => {
  test("两条 compute buffer 相加：174 + 87 MiB", () => {
    const line = (n: number) => `llama_context: compute buffer size = ${String(n)}.00 MiB (type = f16)`;
    const log = [line(174), "llama_context: n_batch = 2048, n_vocab = 131072", line(87)].join("\n");
    expect(parseComputeBufferBytes(log)).toBe(261 * MIB);
  });

  test("GiB：0.5 GiB 两条 → 1 GiB", () => {
    const line = (v: string) => `llama_context: compute buffer size = ${v} GiB (type = f16)`;
    const log = [line("0.50"), "llama_context: n_batch = 2048, n_vocab = 131072", line("0.5")].join("\n");
    expect(parseComputeBufferBytes(log)).toBe(GiB);
  });

  test("没有 → null（kv cache 的数字不算 compute buffer）", () => {
    expect(parseComputeBufferBytes("llama_kv_cache: size = 144.00 MiB")).toBe(null);
    expect(parseComputeBufferBytes("")).toBe(null);
  });
});
