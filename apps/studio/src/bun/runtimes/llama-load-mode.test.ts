import { describe, expect, test } from "bun:test";

import { loadModeArgs, loadModeUnsupported, parseLoadModeSupport } from "./llama-load-mode";

/**
 * 真机证据（llama-server 0.4.0 / build 10809 的 `--help` 原文）：
 *   `-lm, --load-mode MODE  model loading mode (default: auto)`
 *   `--mlock                DEPRECATED in favor of `--load-mode``
 *   `--mmap, --no-mmap      DEPRECATED in favor of `--load-mode``
 * 旧版只有后面两个开关，所以映射表不是猜的 —— 每条等价关系都能在 --help 措辞里对上。
 */

describe("parseLoadModeSupport", () => {
  test("新版：有 --load-mode 就用它", () => {
    const help = "-lm,   --load-mode MODE    model loading mode (default: auto)\n--mlock  DEPRECATED in favor of --load-mode";
    expect(parseLoadModeSupport(help)).toBe("load-mode");
  });

  test("旧版：只有 --mlock / --no-mmap", () => {
    expect(parseLoadModeSupport("--mlock    force system to keep model in RAM")).toBe("legacy");
    expect(parseLoadModeSupport("--mmap, --no-mmap   whether to memory-map model")).toBe("legacy");
  });

  test("探测不到（输出为空 / 不认识）→ unknown：按默认启动，不赌开关存在", () => {
    expect(parseLoadModeSupport("")).toBe("unknown");
    expect(parseLoadModeSupport("Usage: llama-server [options]")).toBe("unknown");
  });
});

describe("loadModeArgs", () => {
  test("默认与空值不发参数：显式 --load-mode auto 与不传等价，少一处版本依赖", () => {
    expect(loadModeArgs("auto", "load-mode")).toEqual([]);
    expect(loadModeArgs("", "load-mode")).toEqual([]);
    expect(loadModeArgs(undefined, "legacy")).toEqual([]);
  });

  test("非法值不发参数（读侧也回落默认，坏值进不了 argv）", () => {
    expect(loadModeArgs("--malicious", "load-mode")).toEqual([]);
  });

  test("新版：直接发 --load-mode <值>", () => {
    expect(loadModeArgs("mlock", "load-mode")).toEqual(["--load-mode", "mlock"]);
    expect(loadModeArgs("mmap+mlock", "load-mode")).toEqual(["--load-mode", "mmap+mlock"]);
    expect(loadModeArgs("dio", "load-mode")).toEqual(["--load-mode", "dio"]);
  });

  test("旧版折算：mlock 与 mmap+mlock 都发 --mlock（旧版默认就是 mmap）", () => {
    expect(loadModeArgs("mlock", "legacy")).toEqual(["--mlock"]);
    expect(loadModeArgs("mmap+mlock", "legacy")).toEqual(["--mlock"]);
  });

  test("旧版折算：none 发 --no-mmap；mmap 是旧版默认，不发参数", () => {
    expect(loadModeArgs("none", "legacy")).toEqual(["--no-mmap"]);
    expect(loadModeArgs("mmap", "legacy")).toEqual([]);
  });

  test("旧版没有 dio：不发参数，并如实报告不支持（不静默降级成别的模式）", () => {
    expect(loadModeArgs("dio", "legacy")).toEqual([]);
    expect(loadModeUnsupported("dio", "legacy")).toBe(true);
    expect(loadModeUnsupported("mlock", "legacy")).toBe(false);
  });

  test("探测失败（unknown）：不发参数，并报告为不支持 —— 用户不会以为设置生效了", () => {
    expect(loadModeArgs("mlock", "unknown")).toEqual([]);
    expect(loadModeUnsupported("mlock", "unknown")).toBe(true);
    expect(loadModeUnsupported("auto", "unknown")).toBe(false);
  });

  test("新版下没有任何「设了但发不出去」的情况", () => {
    for (const mode of ["mmap", "mlock", "mmap+mlock", "none", "dio"]) {
      expect(loadModeUnsupported(mode, "load-mode")).toBe(false);
      expect(loadModeArgs(mode, "load-mode").length).toBe(2);
    }
  });
});
