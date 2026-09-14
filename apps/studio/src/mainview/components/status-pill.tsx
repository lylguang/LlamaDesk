import { useQuery } from "@tanstack/react-query";
import { TriangleAlertIcon } from "lucide-react";

import { rpcClient } from "../lib/rpc";
import { cn } from "../lib/utils";
import { useRouter } from "../stores/router";
import { useServedStore } from "../stores/served";
import { useServerStore } from "../stores/server";
import { useT } from "../stores/ui-lang";

/**
 * 媒体服务告警：端口被另一个数据目录的实例占着时，媒体预览会失败或串到对方数据上，
 * 界面必须说出来——不然用户只会看到一个"文件不存在"的播放器 / 裂图。
 * 服务被挡住时主进程会每几秒重试，对方退出后自动接管，这里的状态随之消失。
 */
function MediaStatusChip() {
  const t = useT();
  const mediaStatus = useServerStore((s) => s.mediaStatus);
  if (mediaStatus.state !== "blocked") return null;
  return (
    <span
      title={t("media.status.blockedHint")}
      className="flex items-center gap-1 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive"
    >
      <TriangleAlertIcon className="size-3" />
      {t("media.status.blocked")}
    </span>
  );
}

/**
 * 顶栏状态胶囊：本地模式显示**运行中的模型数**（多开时不再是一个笼统的「运行中」），
 * 点一下进控制台 —— 启停 / 卸载都在那儿。云端模式显示连通性。
 */
export function StatusPill() {
  const t = useT();
  const serverStatus = useServerStore((s) => s.status);
  const servedModels = useServedStore((s) => s.models);
  const setRoute = useRouter((s) => s.setRoute);

  const { data, isLoading } = useQuery({
    queryKey: ["connection-status"],
    queryFn: () => rpcClient.checkConnection(undefined),
    refetchInterval: 30_000,
  });

  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });

  const isLocal = (settingsData?.settings?.SERVER_MODE ?? "local") === "local";
  const openConsole = () => setRoute({ path: "settings", tab: "logs" });

  if (isLocal) {
    const running = servedModels.filter((m) => m.status === "running").length;
    const loading = servedModels.filter(
      (m) => m.status === "starting" || m.status === "downloading",
    ).length;
    const failed = servedModels.filter((m) => m.status === "error").length;

    const label =
      running > 0
        ? t("server.status.runningCount", { n: String(running) })
        : loading > 0
          ? t("server.startingModel")
          : failed > 0
            ? t("server.status.error")
            : t(`server.status.${serverStatus === "running" ? "stopped" : serverStatus}`);

    const dotClass =
      running > 0
        ? "bg-green-500"
        : loading > 0 || serverStatus === "starting" || serverStatus === "downloading"
          ? "animate-pulse bg-amber-500"
          : failed > 0 || serverStatus === "error"
            ? "bg-destructive"
            : "bg-muted-foreground";

    return (
      <>
        <MediaStatusChip />
        <button
          type="button"
          onClick={openConsole}
          title={t("console.open")}
          className="flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors hover:bg-muted"
        >
          <div className={cn("size-1.5 rounded-full", dotClass)} />
          {label}
        </button>
      </>
    );
  }

  const connected = data?.connected ?? false;
  const label = isLoading ? "Checking…" : connected ? "Connected" : "Disconnected";

  return (
    <>
      <MediaStatusChip />
      <button
        type="button"
        onClick={openConsole}
        title={t("console.open")}
        className="flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors hover:bg-muted"
      >
        <div
          className={cn(
            "size-1.5 rounded-full",
            isLoading
              ? "animate-pulse bg-muted-foreground"
              : connected
                ? "bg-green-500"
                : "bg-destructive",
          )}
        />
        {label}
      </button>
    </>
  );
}
