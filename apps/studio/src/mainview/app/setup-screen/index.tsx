import { useState } from "react";
import { rpcClient } from "@lib/rpc";
import { reportClientError } from "@lib/app-log";
import { LocalFlow } from "./local-flow";
import { RemoteFlow } from "./remote-flow";

export interface SetupScreenProps {
  onComplete: () => void;
}

type ServerMode = "local" | "remote";

export function SetupScreen({ onComplete }: SetupScreenProps) {
  const [mode, setMode] = useState<ServerMode>("local");

  // 「完成 / 跳过」是**无条件**的：先把 SETUP_COMPLETE 写下去，写失败也照样进主界面。
  // 这一步以前只有一个 await：写不进去（或读设置的那条路本身在报错）时，点击就
  // 毫无反应，人被困在引导页里出不来 —— 引导页存在的意义是不挡路，不是必须走完。
  const handleComplete = async () => {
    try {
      await rpcClient.updateSettings({ settings: { SETUP_COMPLETE: "1" } });
    } catch (error) {
      reportClientError("setup.complete_failed", error);
    }
    onComplete();
  };

  return (
    // 高度锁在视口上再滚动：`body` 是 `overflow: hidden`，用 `min-h-screen` + 自适应
    // 高度的话这一页只会长得比窗口更高、被 body 裁掉，且没有任何滚动条 ——
    // 「下一步」「跳过」就永远够不着（模型列表越长越明显）。内层 `min-h-full` 负责
    // 内容短时仍然居中。
    <div className="h-full overflow-y-auto bg-background">
      <div className="electrobun-webkit-app-region-drag fixed inset-x-0 top-0 h-11" />
      <div className="flex min-h-full flex-col items-center justify-center px-6 py-8">
        <div className="w-full max-w-md">
          {mode === "local" ? (
            <LocalFlow onComplete={handleComplete} onSwitchToRemote={() => setMode("remote")} />
          ) : (
            <RemoteFlow onComplete={handleComplete} onSwitchToLocal={() => setMode("local")} />
          )}
        </div>
      </div>
    </div>
  );
}
