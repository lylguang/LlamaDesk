import { Updater } from "electrobun";
import { getWindowRef } from "./window";
import { refreshMenu } from "./menu";
import { getSetting, updateSettings } from "./db/settings";
import { teardownServices } from "./shutdown";
import { logEvent } from "./app-log";

type UpdateStatus =
  | "checking"
  | "update-available"
  | "downloading"
  | "update-ready"
  | "no-update"
  | "error";

export interface UpdateInfo {
  status: UpdateStatus;
  currentVersion: string;
  newVersion?: string;
  error?: string;
}

// Update state
export const updateState: UpdateInfo = {
  status: "checking",
  currentVersion: "0.0.0",
};

export const broadcastUpdateStatus = () => {
  getWindowRef().webview.rpc!.send.updateStatus(updateState);
  refreshMenu();
};

/**
 * 读本机版本 / 渠道，**永不抛错**。
 *
 * Electrobun 的 `getLocallocalInfo()` 是 `Bun.file("../Resources/version.json")` ——
 * 相对**进程工作目录**。正常启动（`open` 拉起）时 cwd 是 `Contents/MacOS`，正好命中；
 * 但只要启动方式换一下（从别的目录直接跑二进制、被第三方工具拉起、升级后由
 * Updater 重新 `open`），这条路径就可能落空，而它是**同步抛错**的：
 * `getMainViewUrl()` 在窗口创建之前 await 它，一抛就是"连窗口都没有的闪退"。
 * 版本号只是一条展示信息，不值得拿启动去换。
 *
 * 注意 `localInfo.*` 那几个取值都是 **async**（内部仍走 getLocallocalInfo），
 * 漏掉 await 会拿到 Promise —— 表现是版本号变成 `[object Promise]` 并被写进设置。
 */
export async function localVersionSafe(): Promise<{ version: string; channel: string }> {
  try {
    const info = Updater.localInfo as
      | { version?: () => Promise<string>; channel?: () => Promise<string> }
      | undefined;
    const version = (await info?.version?.()) ?? "0.0.0";
    const channel = (await info?.channel?.()) ?? "";
    return { version: version || "0.0.0", channel: channel || "" };
  } catch {
    return { version: "0.0.0", channel: "" };
  }
}

/**
 * 启动时记一次"我这一版是几"，与上一版不同就说明**刚升级过**。
 *
 * 升级后起不来是最难查的一类问题：用户只说"更新完就打不开了"，而我们既不知道
 * 他从哪一版升上来，也不知道那次升级有没有走到"新进程起来了"。
 * 这条记录让 app.log 里能直接对上：`update.applied from=0.1.1 to=0.1.2`。
 */
export async function recordBootVersion(): Promise<void> {
  const { version, channel } = await localVersionSafe();
  updateState.currentVersion = version;
  if (version === "0.0.0") return; // 读不出来时不写，免得把好记录覆盖成 0.0.0
  const previous = getSetting("LAST_RUN_VERSION");
  const full = channel && channel !== "stable" ? `${version} (${channel})` : version;
  if (previous === full) return;
  if (previous) {
    logEvent({
      level: "info",
      source: "app",
      event: "update.applied",
      message: `版本已变更：${previous} → ${full}`,
      detail: { from: previous, to: full },
    });
  }
  try {
    updateSettings({ LAST_RUN_VERSION: full });
  } catch {
    // 写不进去只影响下次能不能对比出来，不该拦住启动。
  }
}

// Check for updates
export const checkForUpdate = async () => {
  try {
    const localInfo = await Updater.getLocallocalInfo();
    updateState.currentVersion = localInfo.version;
    updateState.status = "checking";
    broadcastUpdateStatus();

    // Honor the UI-selected update channel when the platform supports it.
    const channel = getSetting("UPDATE_CHANNEL") || "stable";
    const updaterAny = Updater as unknown as Record<string, unknown>;
    if (typeof updaterAny.setChannel === "function") {
      try {
        (updaterAny.setChannel as (c: string) => void).call(Updater, channel);
      } catch {
        // fall through to default channel
      }
    }

    console.log(`Current version: ${localInfo.version} (${localInfo.channel})`);

    const updateInfo = await Updater.checkForUpdate();

    if (updateInfo.error) {
      console.log(`Update check error: ${updateInfo.error}`);
      updateState.status = "error";
      updateState.error = updateInfo.error;
      broadcastUpdateStatus();
      return;
    }

    if (updateInfo.updateAvailable) {
      console.log(`Update available: ${updateInfo.version}`);
      updateState.status = "update-available";
      updateState.newVersion = updateInfo.version;
      broadcastUpdateStatus();

      // Start downloading
      updateState.status = "downloading";
      broadcastUpdateStatus();

      await Updater.downloadUpdate();

      if (Updater.updateInfo().updateReady) {
        console.log("Update downloaded and ready to install");
        updateState.status = "update-ready";
        broadcastUpdateStatus();
      } else {
        console.log("Update download failed");
        updateState.status = "error";
        updateState.error = "Download failed";
        broadcastUpdateStatus();
      }
    } else {
      console.log("No update available");
      updateState.status = "no-update";
      broadcastUpdateStatus();
    }
  } catch (err: any) {
    console.log(`Update check failed: ${err.message}`);
    updateState.status = "error";
    updateState.error = err.message;
    broadcastUpdateStatus();
  }
};

/**
 * 应用已下载好的更新并重启 —— **本应用里唯一允许触发升级的入口**。
 *
 * 不能直接调 `Updater.applyUpdate()`：它内部走的是 Electrobun 的 `quit()`，
 * 而 `quit()` 只**发出** before-quit、不等我们的停服 Promise，随后就 `forceExit`。
 * 结果见 `shutdown.ts` 顶部：上一版的 detached 子进程活过升级，新版本一起来就
 * 抢不到端口与显存（"更新完起不来"）。所以顺序必须是：
 *   1. 确认更新真的就绪（否则收尾完却没有重启，等于把应用停死在这里）；
 *   2. **先 await 收尾**，把子进程与端口还回去；
 *   3. 再交给 Updater 换包重启。
 */
export async function applyUpdateNow(): Promise<{ ok: boolean; error?: string }> {
  if (!Updater.updateInfo().updateReady) {
    return { ok: false, error: "没有已下载好的更新" };
  }
  logEvent({
    level: "info",
    source: "app",
    event: "update.apply.start",
    message: `开始应用更新：${updateState.currentVersion} → ${updateState.newVersion ?? "?"}`,
    detail: { from: updateState.currentVersion, to: updateState.newVersion },
  });
  // 收尾失败也要继续升级：留着一个半停的应用比一个能起来的新版本更糟。
  await teardownServices().catch(() => {});
  await Updater.applyUpdate();
  return { ok: true };
}
