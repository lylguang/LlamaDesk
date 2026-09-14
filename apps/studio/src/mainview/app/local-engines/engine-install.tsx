import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CloudDownloadIcon, Loader2Icon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";

/**
 * llama.cpp 引擎一键安装（LlamaDesk 专有，上游没有这块）。
 *
 * 设置 → 本地模型页的「引擎状态」安装行：自动解析 llama.cpp 最新带二进制的
 * nightly release，下载解压到用户引擎目录；启动时按 内置引擎 → 用户目录安装
 * → PATH 顺序解析二进制。应用内置引擎或 PATH 里已有的一律视为已安装。
 *
 * 上游把 local-engines/ 目录整体删掉、把内容并进了 local-models-screen.tsx，
 * 这份是我们的增量，因此单独留一个文件而不是跟着删。
 */

type EngineStatusTone = "off" | "busy" | "on" | "error";

const TONE_DOT: Record<EngineStatusTone, string> = {
  off: "bg-muted-foreground/50",
  busy: "bg-amber-500 animate-pulse",
  on: "bg-emerald-500",
  error: "bg-destructive",
};

const TONE_TEXT: Record<EngineStatusTone, string> = {
  off: "text-muted-foreground",
  busy: "text-amber-600 dark:text-amber-400",
  on: "text-emerald-600 dark:text-emerald-400",
  error: "text-destructive",
};

/** 状态行：圆点 + 文案（参照设置页「运行状态」排版）。 */
function StatusRow({
  label,
  tone,
  text,
  extra,
}: {
  label: string;
  tone: EngineStatusTone;
  text: string;
  extra?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", TONE_TEXT[tone])}>
        <span className={cn("size-1.5 rounded-full", TONE_DOT[tone])} />
        {text}
      </span>
      {extra}
    </div>
  );
}

/** 引擎安装行：状态 + 未安装时的下载按钮 + 已安装时的二进制路径。 */
export function LlamaEngineInstall() {
  const t = useT();
  const queryClient = useQueryClient();
  const infoQuery = useQuery({
    queryKey: ["llama-engine"],
    queryFn: () => rpcClient.getLlamaEngineInfo(),
  });
  const installMutation = useMutation({
    mutationFn: () => rpcClient.downloadLlamaEngine(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["llama-engine"] }),
  });

  const info = infoQuery.data;
  const installed = !!info?.installed;
  const detail = installed
    ? info?.version
      ? `llama.cpp ${info.version}`
      : t("engine.status.ready")
    : undefined;

  return (
    <div className="space-y-0.5">
      <div className="flex flex-wrap items-center gap-3">
        <StatusRow
          label={t("engine.engineStatus")}
          tone={installed ? "on" : "off"}
          text={installed ? detail ?? t("engine.status.ready") : t("engine.status.notInstalled")}
        />
        {!installed && (
          <Button
            size="sm"
            className="h-7 text-xs"
            disabled={installMutation.isPending}
            onClick={() => installMutation.mutate()}
          >
            {installMutation.isPending ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <CloudDownloadIcon data-icon="inline-start" />
            )}
            {t("engine.downloadEngine")}
          </Button>
        )}
        {installed && info?.binaryPath && (
          <span className="text-[11px] break-all text-muted-foreground/70">{info.binaryPath}</span>
        )}
      </div>
      {installMutation.isError && (
        <p className="text-[11px] break-all text-destructive">{String(installMutation.error)}</p>
      )}
    </div>
  );
}
