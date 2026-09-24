import { existsSync, readFileSync } from "fs";
import { expect, test } from "bun:test";

import { alertCommand, isStartupReady, reportStartupFailure, startupErrorLogPath } from "./startup-guard";

/**
 * 启动守卫的两条不变量（升级后"闪退、起不来"的可见性问题）：
 *
 *   1. 崩溃现场必须落在数据目录的 `logs/startup-error.log`（不依赖数据库、不依赖
 *      electrobun —— 出问题的往往正是这两样）；
 *   2. 提示框命令必须是**平台原生自带的程序**，且把用户可控/上游可控的文本安全地
 *      塞进参数里（否则一个带引号的错误信息就能把命令拆掉）。
 *
 * 这里只测纯函数：真实的弹框与进程退出路径依赖真实平台，端到端验证放在发布前的
 * 手工冒烟里（见 docs/architecture.md 的升级一节）。
 */

test("启动守卫在模块导入期就已接管（否则迁移期异常没人接）", () => {
  // index.ts 第一行就 import 本模块；只要它还是"导入即注册"，这里恒为 false。
  expect(isStartupReady()).toBe(false);
});

test("崩溃现场文件落在数据目录的 logs/ 下", () => {
  const p = startupErrorLogPath();
  // 测试环境的数据目录由 test-preload 指向临时目录，这里只钉住"在数据目录的 logs 下"。
  expect(p.endsWith("/logs/startup-error.log")).toBe(true);
  expect(p).toBe(`${process.env.OMNI_DATA_DIR}/logs/startup-error.log`);
});

test("macOS：osascript display alert，且反斜杠与双引号都被转义", () => {
  const plan = alertCommand("darwin", "标题", '他说"坏了" C:\\tmp\\x');
  expect(plan?.command).toBe("osascript");
  expect(plan?.args[0]).toBe("-e");
  const script = plan!.args[1]!;
  expect(script).toContain('display alert "标题"');
  expect(script).toContain('\\"坏了\\"');
  expect(script).toContain("C:\\\\tmp\\\\x");
  // 双引号没有被"逃逸"到脚本之外：整条 -e 参数仍然是一个字符串
  expect(script.startsWith("display alert \"")).toBe(true);
});

test("Windows：PowerShell 里单引号翻倍，不会把命令拆开", () => {
  const plan = alertCommand("win32", "Oops", "it's broken; rm -rf /");
  expect(plan?.command).toBe("powershell");
  const last = plan!.args[plan!.args.length - 1]!;
  expect(last).toContain("''");
  expect(last).toContain("MessageBox");
  // 分号留在字符串里，不会被当成第二条语句
  expect(last).toContain("it''s broken; rm -rf /");
});

test("Linux：走 zenity，标题与正文是独立参数（不拼进一条 shell 字符串）", () => {
  const plan = alertCommand("linux", "T", "B; rm -rf /");
  expect(plan?.command).toBe("zenity");
  expect(plan?.args).toEqual(["--error", "--title", "T", "--text", "B; rm -rf /"]);
});

test("未知平台：不猜命令（返回 null，只留崩溃文件）", () => {
  expect(alertCommand("aix", "T", "B")).toBeNull();
});

test("超长/带控制字符的信息被夹住，不会把弹框撑爆", () => {
  const plan = alertCommand("darwin", "T", "x".repeat(5000) + "\u0007\u0000end");
  const msg = plan!.args[1]!;
  expect(msg).not.toContain("\u0007");
  expect(msg).not.toContain("\u0000");
  expect(msg.length).toBeLessThan(1500);
});

test("报错时崩溃现场与 app.log **同步**落盘（紧接着就 exit，异步写会丢）", () => {
  // 真机验证过一次：崩溃文件有了，app.log 里却没有记录 —— 因为那条事件以前是
  // `void import(...)` 异步写的，而 handle() 马上 process.exit(1)。
  process.env.OMNI_NO_ALERTS = "1"; // 自动化环境不弹框（否则测试会被对话框卡住）
  try {
    const body = reportStartupFailure(new Error("file is not a database"), "uncaughtException");

    const crash = readFileSync(startupErrorLogPath(), "utf8");
    expect(crash).toContain("file is not a database");
    expect(crash).toContain("uncaughtException");

    const appLog = `${process.env.OMNI_DATA_DIR}/logs/app.log`;
    expect(existsSync(appLog)).toBe(true);
    expect(readFileSync(appLog, "utf8")).toContain("app.start.failed");

    // 用户看到的正文要能指路（库路径 / 日志位置），而不只是一句堆栈。
    expect(body).toContain("启动失败");
    expect(body).toContain("logs/startup-error.log");
    expect(body).toContain(process.env.OMNI_DATA_DIR!);
  } finally {
    delete process.env.OMNI_NO_ALERTS;
  }
});
