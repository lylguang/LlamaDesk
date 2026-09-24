/**
 * 统一的收尾（停服）入口。
 *
 * 为什么单独一个模块：这条链以前写在 `index.ts` 的窗口 close / before-quit 里，
 * **升级**走的是另一条路（`Updater.applyUpdate()` 内部直接 `quit()`），两者并不等价：
 *
 *   - Electrobun 的 `quit()` 只是**发出** before-quit 事件，不等我们的 Promise ——
 *     而这里每一项都是异步的。升级时进程往往在我们的停服还没跑完就被 `forceExit` 了。
 *   - 结果是上一版留下的 **detached 子进程**（推理服务器等）活过升级，占着端口与
 *     显存，新版本一起来就抢不到资源 —— 表现就是"更新完起不来 / 模型服务起不来"。
 *     （真机证据：升级过的机器上能查到好几天前启动、pid 早已不属于任何窗口的
 *     llama-server。）
 *
 * 所以升级路径必须**先 await 这份收尾**，再把进程交给 Updater。
 * 也正因为如此，它必须和 `index.ts` 的退出路径共用同一份实现，不能再写第二遍。
 */
import * as ServerManager from "./server-manager";
import { stopAllServed } from "./model-servers";
import { stopAsr } from "./asr";
import { stopPpOcr } from "./ppocr";
import * as Gateway from "./gateway";
import * as Tunnel from "./tunnel";
import { closeAllTerminals } from "./terminal-sessions";
import { shutdownSkills } from "./skills";
import { stopControlServer } from "./control-server";
import { stopAllAgentRuns } from "./agent";

let teardownDone: Promise<void> | null = null;

/**
 * 停掉所有后台服务与子进程。幂等：重复调用（close / before-quit / 升级）共用同一次。
 * 单项失败不影响其余项 —— 收尾阶段最容易出问题的就是"一个失败把其余都跳过"，
 * 那样又会留下孤儿进程。
 */
export function teardownServices(): Promise<void> {
  if (teardownDone) return teardownDone;
  teardownDone = (async () => {
    // 隧道先同步掐掉：漏掉它留下的是一条**公开入口**，不能等优雅退出。
    Tunnel.stopTunnelSync();
    const results = await Promise.allSettled([
      stopAllServed(),
      stopAsr(),
      stopPpOcr(),
      Gateway.stopGateway(),
    ]);
    for (const r of results) {
      if (r.status === "rejected") {
        void import("./app-log")
          .then((m) =>
            m.logEvent({
              level: "warn",
              source: "app",
              event: "app.teardown.item_failed",
              message: r.reason instanceof Error ? r.reason.message : String(r.reason),
            }),
          )
          .catch(() => {});
      }
    }
    // 侧栏终端 shell：跟着一起收掉，别留下没人管的会话。
    closeAllTerminals();
    // agent 回合与侧栏终端同类：不请求停止，它的 detached bash 会活成孤儿。
    stopAllAgentRuns();
    shutdownSkills();
    stopControlServer();
  })();
  return teardownDone;
}

/** 同步版兜底（SIGTERM 之类不能等 Promise 的路径）。 */
export function teardownServicesSync(): void {
  ServerManager.forceKill();
  Tunnel.stopTunnelSync();
  closeAllTerminals();
  stopAllAgentRuns();
  shutdownSkills();
  stopControlServer();
}
