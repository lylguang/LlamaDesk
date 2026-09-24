import { afterEach, describe, expect, test } from "bun:test";

import {
  cachedFlashAttnSupport,
  cachedServerHelpSupport,
  clearServerHelpSupportCache,
  flashAttnArgs,
  parseServerHelpSupport,
  setCachedServerHelpSupport,
} from "./llama-flash-attn";

/**
 * 真机证据（本机 llama.cpp 的 `--help` 原文）：
 *   `-fa, --flash-attn [on|off|auto]    set Flash Attention use ('on', 'off', or 'auto', default: 'auto')`
 * 老一些的 build 里只有不带值的 `-fa, --flash-attn`；更老的没有。
 */

describe("parseServerHelpSupport / flashAttn", () => {
  test("新版三态：同一行含 [on|off|auto] → tristate", () => {
    const help =
      "Options:\n" +
      "  -f,   --flash-attn [on|off|auto]    set Flash Attention use ('on', 'off', or 'auto', default: 'auto')\n";
    expect(parseServerHelpSupport(help).flashAttn).toBe("tristate");
  });

  test("新版三态（任务里给的原始措辞：-fa, --flash-attn [on|off|auto]）", () => {
    const help =
      "-fa, --flash-attn [on|off|auto]    set Flash Attention use ('on', 'off', or 'auto', default: 'auto')\n" +
      "      (env: LLAMA_ARG_FLASH_ATTN)\n";
    expect(parseServerHelpSupport(help).flashAttn).toBe("tristate");
  });

  test("老版布尔：只有 -fa, --flash-attn，没有取值列表 → boolean", () => {
    expect(
      parseServerHelpSupport("-fa, --flash-attn           whether to use Flash Attention").flashAttn,
    ).toBe("boolean");
    expect(
      parseServerHelpSupport("  -fa, --flash-attn\n      enable Flash Attention (default: off)").flashAttn,
    ).toBe("boolean");
  });

  test("没有 flash-attn → none", () => {
    expect(parseServerHelpSupport("").flashAttn).toBe("none");
    expect(parseServerHelpSupport("Usage: llama-server [options]").flashAttn).toBe("none");
  });

  test("load-mode 与 flash-attn 同一次解析（合并探测）", () => {
    const help =
      "-lm,   --load-mode MODE    model loading mode (default: auto)\n" +
      "  -fa, --flash-attn [on|off|auto]    set Flash Attention use\n";
    const support = parseServerHelpSupport(help);
    expect(support.loadMode).toBe("load-mode");
    expect(support.flashAttn).toBe("tristate");
  });
});

describe("flashAttnArgs", () => {
  test("tristate：三态原样发（auto 与不传等价但显式发出去，让 llama-server 日志打印实际值）", () => {
    expect(flashAttnArgs("auto", "tristate")).toEqual(["--flash-attn", "auto"]);
    expect(flashAttnArgs("on", "tristate")).toEqual(["--flash-attn", "on"]);
    expect(flashAttnArgs("off", "tristate")).toEqual(["--flash-attn", "off"]);
    expect(flashAttnArgs(null, "tristate")).toEqual(["--flash-attn", "auto"]);
  });

  test("boolean：只有 on 发（不带值），auto / off 不发", () => {
    expect(flashAttnArgs("on", "boolean")).toEqual(["--flash-attn"]);
    expect(flashAttnArgs("auto", "boolean")).toEqual([]);
    expect(flashAttnArgs("off", "boolean")).toEqual([]);
  });

  test("none：一个参数都不发（与加这个开关前逐字节一致）", () => {
    for (const v of ["auto", "on", "off", null]) {
      expect(flashAttnArgs(v, "none")).toEqual([]);
    }
  });

  test("非法值（手改设置行）：tristate 时回落 auto，boolean / none 不发", () => {
    expect(flashAttnArgs("--evil", "tristate")).toEqual(["--flash-attn", "auto"]);
    expect(flashAttnArgs("--evil", "boolean")).toEqual([]);
    expect(flashAttnArgs("--evil", "none")).toEqual([]);
  });
});

describe("support cache", () => {
  afterEach(() => clearServerHelpSupportCache());

  test("未探测 → null（同步路径按 none 处理）", () => {
    expect(cachedFlashAttnSupport("/bin/x")).toBeNull();
    expect(cachedServerHelpSupport("/bin/x")).toBeNull();
  });

  test("setCachedServerHelpSupport 后两个缓存可读；unknown load-mode 不落", () => {
    setCachedServerHelpSupport("/bin/x", { loadMode: "unknown", flashAttn: "tristate" });
    expect(cachedFlashAttnSupport("/bin/x")).toBe("tristate");
    const support = cachedServerHelpSupport("/bin/x");
    expect(support).not.toBeNull();
    // loadMode 是 unknown → 合并读回落 unknown（等价于「load-mode 还没探过」）
    expect(support!.loadMode).toBe("unknown");
    expect(support!.flashAttn).toBe("tristate");
  });

  test("load-mode 成功探测后 cachedServerHelpSupport 直接返回它", () => {
    setCachedServerHelpSupport("/bin/y", { loadMode: "load-mode", flashAttn: "boolean" });
    const support = cachedServerHelpSupport("/bin/y");
    expect(support?.loadMode).toBe("load-mode");
    expect(support?.flashAttn).toBe("boolean");
  });
});
