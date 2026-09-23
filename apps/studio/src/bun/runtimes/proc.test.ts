import { describe, expect, test } from "bun:test";

import { collapseCarriageReturns, killProcessTree, probeCommand, spawnServerProcess, waitExit } from "./proc";

/** 进程组是否还存在（不存在 → ESRCH，返回 false）。 */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("collapseCarriageReturns", () => {
  test("保留 \\r 进度条的最后一段", () => {
    expect(collapseCarriageReturns("10%\r50%\r100%\n")).toBe("100%\n");
    expect(collapseCarriageReturns("no cr")).toBe("no cr");
    expect(collapseCarriageReturns("a\r\nb")).toBe("a\nb");
  });
});

describe("killProcessTree", () => {
  test("杀掉整个进程组（孙进程不再是孤儿）", async () => {
    // 模拟真实形态：启动器 -> 推理进程。只杀直接子进程会留下 sleep 孤儿。
    const proc = spawnServerProcess(["/bin/sh", "-c", "sleep 30 & sleep 30"]);
    await Bun.sleep(200);
    const pid = proc.pid;
    expect(pid).toBeGreaterThan(0);
    expect(groupAlive(pid)).toBe(true);

    killProcessTree(proc, "SIGKILL");
    await Bun.sleep(300);
    expect(groupAlive(pid)).toBe(false);
  });

  test("传入 null 或已退出的进程不抛错", async () => {
    expect(() => killProcessTree(null)).not.toThrow();
    const proc = spawnServerProcess(["/bin/sh", "-c", "exit 0"]);
    await proc.exited;
    expect(() => killProcessTree(proc, "SIGTERM")).not.toThrow();
  });
});

describe("spawnServerProcess", () => {
  test("stdout/stderr 可读，退出码可获取", async () => {
    const proc = spawnServerProcess(["/bin/sh", "-c", "echo hello; echo err >&2; exit 3"]);
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(out.trim()).toBe("hello");
    expect(err.trim()).toBe("err");
    expect(code).toBe(3);
  });
});

/**
 * 引擎探测必须看**退出码**，不能只看"进程退出了"。
 *
 * 此前 vLLM / SGLang / MLX 的 `checkBinary` 用的是 `waitExit`（它回答的是"退出了吗"，
 * 给 SIGTERM → SIGKILL 分级用的）—— 于是 `python3 -m vllm --help` 在没有 vllm 的机器
 * 上以退出码 1 结束，同样被判成"已安装"，引导页与引擎管理页因此显示一个跑不起来的
 * 引擎"就绪"（真机实测：装了 python3 的 macOS 上 vLLM / SGLang 双双报 found）。
 */
describe("probeCommand", () => {
  test("退出码为 0 才算通过", async () => {
    expect(await probeCommand(["/bin/sh", "-c", "exit 0"])).toBe(true);
    expect(await probeCommand(["/bin/sh", "-c", "exit 1"])).toBe(false);
  });

  test("与 waitExit 的差别就在退出码上（同一个立刻报错的命令）", async () => {
    expect(await waitExit(Bun.spawn(["/bin/sh", "-c", "exit 1"]), 5_000)).toBe(true);
    expect(await probeCommand(["/bin/sh", "-c", "exit 1"])).toBe(false);
  });

  test("超时算不通过，且不留挂着的子进程", async () => {
    const started = Date.now();
    expect(await probeCommand(["/bin/sh", "-c", "sleep 10"], 300)).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("命令不存在时不抛，算不通过", async () => {
    expect(await probeCommand(["/definitely/missing/binary", "--version"])).toBe(false);
  });
});
