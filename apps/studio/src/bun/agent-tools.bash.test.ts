import { describe, expect, test } from "bun:test";

import { buildAgentTools, resolveCommandTimeout } from "./agent-tools";

function bashTool(opts?: { commandTimeoutMs?: number }) {
  const tools = buildAgentTools({
    workspace: process.cwd(),
    allowShell: true,
    ...opts,
  });
  const tool = tools.find((item) => item.name === "bash");
  if (!tool) throw new Error("bash tool not found");
  return tool;
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content
    .map((c) => c.text ?? "")
    .join("\n");
}

describe("bash 工具", () => {
  /**
   * 回归：命令里带 `&` 拉起后台进程时，后台进程会继承 stdout 管道。
   * 老实现直接 `new Response(proc.stdout).text()` 等 EOF —— 后台进程不死就永远等不到，
   * 工具（以及整轮 Agent）会永久卡住，120 秒的超时也救不回来（定时器早就跑完了）。
   */
  test("后台进程占着 stdout 时也立刻返回，不等管道 EOF", async () => {
    const tool = bashTool();
    const started = Date.now();
    const result = await tool.execute("t1", { command: "sleep 3 & echo spawned" }, undefined);
    const elapsed = Date.now() - started;

    expect(textOf(result)).toContain("spawned");
    expect(elapsed).toBeLessThan(2000);
  });

  test("超时终止整条进程组：后台孙进程不会变成孤儿", async () => {
    const tool = bashTool({ commandTimeoutMs: 400 });
    const started = Date.now();
    const result = await tool.execute("t2", { command: "sleep 37 & sleep 37" }, undefined);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(3000);
    expect(textOf(result)).toContain("已连同子进程一起终止");

    // SIGKILL 进程组后不应再有残留（老实现只杀 shell，sleep 会活下来）。
    await Bun.sleep(300);
    const leftover = Bun.spawnSync(["pgrep", "-f", "sleep 37"]);
    expect(leftover.stdout.toString().trim()).toBe("");
  });

  test("用户点停止：命令被终止并在结果里说明", async () => {
    const controller = new AbortController();
    const tool = bashTool();
    const pending = tool.execute("t3", { command: "sleep 30" }, controller.signal);
    setTimeout(() => controller.abort(), 100);

    const result = await pending;
    expect(textOf(result)).toContain("已随本次运行停止一并终止");
  });

  test("普通命令照常返回输出与退出码", async () => {
    const tool = bashTool();
    const result = await tool.execute("t4", { command: "echo hello && exit 3" }, undefined);
    const text = textOf(result);
    expect(text).toContain("hello");
    expect(text).toContain("[exit 3]");
  });

  test("传了 timeout_ms 就按它来，不再写死 120 秒", async () => {
    const tool = bashTool();
    const started = Date.now();
    const result = await tool.execute(
      "t5",
      { command: "sleep 5", timeout_ms: 300 },
      undefined,
    );
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(3000);
    expect(textOf(result)).toContain("已连同子进程一起终止");
    expect(textOf(result)).toContain("超过 1 秒");
  });

  test("resolveCommandTimeout：参数夹在 [1000, 600000]，非法值退回 ctx / 默认", () => {
    expect(resolveCommandTimeout(999_999_999, undefined)).toBe(600_000);
    expect(resolveCommandTimeout(300, undefined)).toBe(1_000);
    expect(resolveCommandTimeout(0, 4_000)).toBe(4_000);
    expect(resolveCommandTimeout(-5, undefined)).toBe(120_000);
    expect(resolveCommandTimeout(Number.NaN, undefined)).toBe(120_000);
    expect(resolveCommandTimeout(Number.POSITIVE_INFINITY, undefined)).toBe(120_000);
    expect(resolveCommandTimeout(undefined, undefined)).toBe(120_000);
    expect(resolveCommandTimeout(undefined, 4_000)).toBe(4_000);
    expect(resolveCommandTimeout(30_000, 4_000)).toBe(30_000);
  });
});
