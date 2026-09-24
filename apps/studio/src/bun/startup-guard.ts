/**
 * 启动守卫：把"起不来"从**静默闪退**变成一条看得见的提示。
 *
 * 背景（issue #28 之后用户报的「升级后容易闪退，起不来」）：主进程的启动是一条
 * 模块求值链，其中任何一处抛错都会让 Worker 直接退出 —— 没有窗口、没有对话框、
 * 用户只看到图标闪一下。最典型的是 `./db` 的迁移失败：`db/index.ts` 会抛出
 * 一条信息量很足的报错（含库路径、迁移前备份位置、详细日志路径），但没人看得到。
 *
 * 更麻烦的是它**只在升级后**出现：新版本带来新迁移，而用户刚点过"重启并更新"，
 * 于是"更新完就打不开了"。
 *
 * 这个模块必须在 `./db` 之前被导入（`index.ts` 的第一行），因为：
 *   - 只有比所有会抛错的模块先注册好监听器，模块求值期的异常才会经过这里；
 *   - 求值期的异常在 Bun 里以 `uncaughtException` 事件送出（已实测），
 *     所以不需要改构建入口。
 *
 * 两条纪律：
 *   1. 启动**完成**之后不再插手（`markStartupReady()`），把现场留给 `index.ts`
 *      自己的 uncaughtException / unhandledRejection 处理 —— 否则同一个错误会被
 *      处理两遍（多弹一个框、多退一次）。
 *   2. 绝不在守卫里 import electrobun：致命错误往往发生在原生事件循环起来之前，
 *      走 FFI 弹框有死锁风险；这里改用外部的系统弹框命令（子进程，不依赖事件循环）。
 */
import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { getDataDir } from "./paths";
import { logEvent } from "./app-log";

let startupReady = false;

/** 启动完成（窗口与后台服务都已就绪）后调用：之后本模块不再接管异常。 */
export function markStartupReady(): void {
  startupReady = true;
}

export function isStartupReady(): boolean {
  return startupReady;
}

/** 崩溃现场文件：不依赖数据库、不依赖 electrobun，只追加文本。 */
export function startupErrorLogPath(): string {
  return getDataDir("logs", "startup-error.log");
}

export type AlertPlan = {
  command: string;
  args: string[];
};

/**
 * 生成一条"系统原生提示框"命令。纯函数，便于测试。
 *
 * 只用系统自带、一定存在的程序，失败一律忽略 —— 这里的目标是"尽力让用户看到"，
 * 不是"保证弹出"。返回 null 表示当前平台没有可用的方案。
 */
export function alertCommand(
  platform: string,
  title: string,
  message: string,
): AlertPlan | null {
  // 控制字符会把参数截断或注入，一并清掉；长度上限只是防止弹框被撑爆。
  const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, 1200);
  const t = clean(title);
  const m = clean(message);

  if (platform === "darwin") {
    // osascript 里字符串用双引号包裹，所以只需转义 `\` 与 `"`。
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return {
      command: "osascript",
      args: ["-e", `display alert "${esc(t)}" message "${esc(m)}" as critical`],
    };
  }
  if (platform === "win32") {
    // PowerShell 单引号字符串：内部的单引号写成两个。
    const esc = (s: string) => s.replace(/'/g, "''");
    const script =
      "Add-Type -AssemblyName PresentationFramework; " +
      `[System.Windows.MessageBox]::Show('${esc(m)}','${esc(t)}','OK','Error') | Out-Null`;
    return {
      command: "powershell",
      args: ["-NoProfile", "-NonInteractive", "-Command", script],
    };
  }
  if (platform === "linux") {
    return { command: "zenity", args: ["--error", "--title", t, "--text", m] };
  }
  return null;
}

/**
 * 把致命启动错误落盘（崩溃现场文件 + app.log），并尽力弹一条系统提示框。
 * 返回给用户看的正文，便于测试与调用方复用。
 */
export function reportStartupFailure(err: unknown, origin: string): string {
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const stack = err instanceof Error && err.stack ? `\n\n${err.stack}` : "";
  const body =
    `OmniStudio 启动失败，窗口没有打开。\n\n` +
    `错误：${detail}\n` +
    `来源：${origin}\n` +
    `数据目录：${getDataDir()}\n\n` +
    `排查入口：数据目录下 logs/app.log（omi logs）与 logs/startup-error.log。`;

  writeCrashRecord({ origin, detail, stack });
  alertBestEffort("OmniStudio 启动失败", body);
  return body;
}

function writeCrashRecord(entry: { origin: string; detail: string; stack: string }): void {
  const line =
    `[${new Date().toISOString()}] ${entry.origin}\n` +
    `pid: ${process.pid}  platform: ${process.platform}/${process.arch}\n` +
    `${entry.detail}${entry.stack}\n` +
    `${"-".repeat(72)}\n`;
  try {
    const path = startupErrorLogPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line, "utf8");
  } catch {
    // 崩溃现场文件写不下去（磁盘满 / 只读）时不再制造第二个错误。
  }
  // app.log 是排查的**唯一**入口，这条必须**同步**写：紧接着就是 `process.exit(1)`，
  // 任何 `void import(...).then(...)` 都可能来不及落盘（真机验证过一次：崩溃文件有了，
  // app.log 里却没有记录）。app-log 只依赖 paths，在启动这么早的位置加载是安全的。
  logEvent({
    level: "error",
    source: "app",
    event: "app.start.failed",
    message: entry.detail,
    detail: { origin: entry.origin, recovery: "见 logs/startup-error.log" },
  });
}

function alertBestEffort(title: string, message: string): void {
  // 自动化环境（测试 / CI / 无头冒烟）不该被一个必须点掉的对话框卡住。
  if (process.env.OMNI_NO_ALERTS === "1") return;
  const plan = alertCommand(process.platform, title, message);
  if (!plan) return;
  try {
    // detached + 不等待：弹框要活到本进程退出之后（我们马上就要 exit）。
    Bun.spawn([plan.command, ...plan.args], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // 平台没有该程序（例如没装 zenity）时静默 —— 崩溃文件仍然写下了现场。
  }
}

function handle(err: unknown, origin: string): void {
  // 启动已完成 → 交给 index.ts 的常规处理，避免同一个错误被处理两遍。
  if (startupReady) return;
  reportStartupFailure(err, origin);
  // 启动没走完就出致命错误：进程状态已不可信，明确退出（而不是留一个半死的实例
  // 占着端口与数据目录，让下一次启动更难）。
  process.exit(1);
}

// 必须在 import 期就注册：模块求值期的异常不会再给调用方"稍后注册"的机会。
// `process.on` 会追加监听器而不是替换，所以 index.ts 后续注册的那套照旧生效。
process.on("uncaughtException", (err) => handle(err, "uncaughtException"));
process.on("unhandledRejection", (reason) => handle(reason, "unhandledRejection"));
