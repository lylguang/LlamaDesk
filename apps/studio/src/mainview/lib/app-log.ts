import { rpcClient } from "./rpc";

/**
 * 前端（webview）侧的错误上报 —— 同一个目的地的另一半。
 *
 * 渲染错误、未捕获异常、未处理的 Promise rejection 原来只进浏览器 console，
 * 打包应用里没人看得到。这里统一写进主进程的 `logs/app.log`（source=client），
 * 排查时和生图 / 推理服务 / Agent 的失败在同一条时间线上。
 *
 * 上报本身绝不能反过来搞崩界面：所有调用都吞掉异常。
 */

function describe(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) return { message: error.message, stack: error.stack };
  if (typeof error === "string") return { message: error };
  try {
    return { message: JSON.stringify(error) };
  } catch {
    return { message: String(error) };
  }
}

export function reportClientError(
  event: string,
  error: unknown,
  detail?: Record<string, unknown>,
): void {
  const { message, stack } = describe(error);
  try {
    void rpcClient
      .writeAppLog({
        level: "error",
        source: "client",
        event,
        message: message.slice(0, 500),
        detail: { ...detail, stack: stack?.split("\n").slice(0, 8).join("\n") },
      })
      .catch(() => {
        // 主进程不可用（重启中 / 已退出）时放弃上报，不影响界面。
      });
  } catch {
    // 同上：上报失败永远不是 UI 的错误。
  }
}

/** 全局兜底：window.onerror 与 unhandledrejection（App 之外的错误也要有记录）。 */
export function installClientErrorReporting(): void {
  window.addEventListener("error", (event) => {
    reportClientError("client.window_error", event.error ?? event.message, {
      sourceUrl: event.filename,
      line: event.lineno,
      column: event.colno,
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    reportClientError("client.unhandled_rejection", event.reason);
  });
}
