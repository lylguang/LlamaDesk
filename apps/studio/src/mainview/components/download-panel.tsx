import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DownloadCloudIcon,
  PauseIcon,
  PlayIcon,
  XIcon,
  Trash2Icon,
  Loader2Icon,
  RotateCcwIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { ScrollArea } from "@ui/scroll-area";
import { useModelDownloadStore } from "@stores/model-download";
import { useT } from "@stores/ui-lang";
import {
  formatBytes,
  formatEta,
  groupDownloadsByRepo,
  summarizeDownloads,
  type ModelDownloadGroup,
} from "@lib/download-view";
import { SourceBadge } from "./source-badge";
import type { DownloadTask } from "../../bun/download-manager";
import { cn } from "@/mainview/lib/utils";

const STATUS_STYLES: Record<DownloadTask["status"], string> = {
  queued: "bg-muted-foreground/15 text-muted-foreground",
  downloading: "bg-blue-500/15 text-blue-500",
  paused: "bg-amber-500/15 text-amber-500",
  completed: "bg-emerald-500/15 text-emerald-500",
  failed: "bg-destructive/15 text-destructive",
  canceled: "bg-muted-foreground/15 text-muted-foreground",
};

/**
 * 一个模型一行。
 *
 * 下载的单元是「模型」而不是「文件」：safetensors 仓库的十几个分片 + config +
 * tokenizer 本来就只能一起下完才有用，逐文件列进度既看不出整体下了多少，也让
 * 这个 320px 宽的面板被十几个进度条淹没。任务仍然是文件级的（断点续传、重试都
 * 在那儿），这里只把同一 repo 的任务聚合成一条展示。
 */
function ModelRow({ group }: { group: ModelDownloadGroup }) {
  const t = useT();
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["model-downloads"] });

  // 组级按钮 = 对组内每个文件各调一次既有 RPC（单文件级接口不变）。
  const pause = useMutation({
    mutationFn: async () => {
      for (const task of group.tasks) {
        if (task.status === "downloading") await rpcClient.pauseModelDownload({ id: task.id });
      }
    },
    onSuccess: invalidate,
  });
  const resume = useMutation({
    mutationFn: async () => {
      for (const task of group.tasks) {
        if (task.status === "paused" || task.status === "failed") {
          await rpcClient.resumeModelDownload({ id: task.id });
        }
      }
    },
    onSuccess: invalidate,
  });
  const cancel = useMutation({
    mutationFn: async () => {
      for (const task of group.tasks) {
        if (task.status === "downloading" || task.status === "queued" || task.status === "paused") {
          await rpcClient.cancelModelDownload({ id: task.id });
        }
      }
    },
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: async () => {
      for (const task of group.tasks) await rpcClient.removeDownload({ id: task.id });
    },
    onSuccess: invalidate,
  });

  const busy = pause.isPending || resume.isPending || cancel.isPending || remove.isPending;
  const { summary, status } = group;
  // GGUF 单文件组用文件名做标题（每个量化是独立模型），多文件模型用仓库名。
  const bare = group.repo.split("/").pop() || group.repo;
  const title = group.fileName ?? bare;
  const eta = status === "downloading" ? formatEta(summary.remainingBytes, summary.speed, t) : null;
  const showProgress = status !== "completed" && status !== "canceled";
  const canResume = status === "paused" || status === "failed";
  const canCancel = status === "downloading" || status === "queued" || status === "paused";

  return (
    <div className="rounded-lg border px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium" title={group.label}>
            {title}
          </p>
          <div className="mt-0.5 flex items-center gap-1.5">
            <SourceBadge source={group.source} />
            <span className="truncate font-mono text-[10px] text-muted-foreground/70">
              {group.repo}
            </span>
          </div>
          <p className="mt-0.5 text-[10px] text-muted-foreground tabular-nums">
            {t("downloads.groupFiles", {
              done: String(group.doneCount),
              total: String(group.fileCount),
            })}
            {summary.percent != null
              ? ` · ${formatBytes(summary.received)} / ${formatBytes(summary.total)}`
              : summary.received > 0
                ? ` · ${formatBytes(summary.received)}`
                : ""}
            {summary.speed > 0 ? ` · ${formatBytes(summary.speed)}/s` : ""}
            {eta ? ` · ${eta}` : ""}
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
            STATUS_STYLES[status],
          )}
        >
          {t(`downloads.status.${status}`)}
        </span>
      </div>

      {showProgress && (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-200",
              status === "failed" ? "bg-destructive" : "bg-primary",
            )}
            style={{ width: `${summary.percent ?? 0}%` }}
          />
        </div>
      )}
      {group.failedCount > 0 && (
        <p className="mt-1 truncate text-[10px] text-destructive">
          {t("downloads.groupFailed", { n: String(group.failedCount) })}
        </p>
      )}

      <div className="mt-2 flex items-center justify-end gap-1">
        {canResume && (
          <Button
            variant="outline"
            size="icon-sm"
            tooltip={t("downloads.resume")}
            disabled={busy}
            onClick={() => resume.mutate()}
          >
            {status === "failed" ? (
              <RotateCcwIcon className="size-3.5" />
            ) : (
              <PlayIcon className="size-3.5" />
            )}
          </Button>
        )}
        {status === "downloading" && (
          <Button
            variant="outline"
            size="icon-sm"
            tooltip={t("downloads.pause")}
            disabled={busy}
            onClick={() => pause.mutate()}
          >
            <PauseIcon className="size-3.5" />
          </Button>
        )}
        {canCancel && (
          <Button
            variant="outline"
            size="icon-sm"
            tooltip={t("downloads.cancel")}
            disabled={busy}
            onClick={() => cancel.mutate()}
          >
            <XIcon className="size-3.5" />
          </Button>
        )}
        {!canCancel && (
          <Button
            variant="outline"
            size="icon-sm"
            tooltip={t("common.delete")}
            disabled={busy}
            onClick={() => remove.mutate()}
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

export function DownloadsButton() {
  const t = useT();
  const tasks = useModelDownloadStore((s) => s.tasks);
  const setTasks = useModelDownloadStore((s) => s.setTasks);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  // Load task list once on mount (broadcasts keep it fresh afterwards).
  useEffect(() => {
    void rpcClient.listDownloads().then((r) => setTasks(r.tasks));
  }, [setTasks]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const groups = groupDownloadsByRepo(tasks);
  const activeGroups = groups.filter((g) => g.status === "downloading" || g.status === "queued").length;
  const completedGroups = groups.filter((g) => g.status === "completed").length;
  // 聚合信息：合计已下/总量 · 速度 · 剩余时间（总量未知时退化成只显示速度）。
  const summary = summarizeDownloads(tasks);
  const summaryEta = formatEta(summary.remainingBytes, summary.speed, t);
  const summaryText =
    summary.activeCount === 0
      ? null
      : summary.percent != null
        ? t("downloads.summary", {
            done: formatBytes(summary.received),
            total: formatBytes(summary.total),
            speed: formatBytes(summary.speed),
            eta: summaryEta ?? t("downloads.etaUnknown"),
          })
        : t("downloads.speedOnly", { speed: formatBytes(summary.speed) });

  const clearCompleted = () => {
    for (const group of groups) {
      if (group.status !== "completed") continue;
      for (const task of group.tasks) {
        void rpcClient.removeDownload({ id: task.id }).then(() => {
          queryClient.invalidateQueries({ queryKey: ["model-downloads"] });
        });
      }
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <Button
        variant="ghost"
        size="icon-sm"
        tooltip={t("downloads.title")}
        onClick={() => setOpen((v) => !v)}
      >
        {activeGroups > 0 ? (
          <Loader2Icon className="size-4 animate-spin" />
        ) : (
          <DownloadCloudIcon className="size-4" />
        )}
        {activeGroups > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-primary text-[9px] font-semibold text-primary-foreground">
            {activeGroups > 9 ? "9+" : activeGroups}
          </span>
        )}
      </Button>

      {open && (
        // 高度上限必须落在祖先的「确定高度」上（h-*，不是 max-h-*）—— Radix 视口的
        // 高度是 height:100%，只有祖先链上有确定高度时才解析得出滚动高度。实测：
        // 祖先只给 max-h 时视口被内容撑开 1889px、顶穿 384px 的盒子，列表被裁掉
        // 且没法下拉。滚动区自己也带确定高度，双保险。
        <div className="absolute top-full right-0 z-50 mt-2 flex h-[min(24rem,calc(100vh-4rem))] w-80 flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
            <div className="flex min-w-0 flex-col">
              <span className="min-w-0 truncate text-xs font-medium">
                {t("downloads.title")}
                <span className="ml-1.5 text-muted-foreground">({groups.length})</span>
              </span>
              {/* 聚合进度：合计已下/总量 · 速度 · 剩余时间 */}
              {summaryText && (
                <span className="truncate text-[10px] text-muted-foreground tabular-nums">
                  {summaryText}
                </span>
              )}
            </div>
            {completedGroups > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 shrink-0 text-[11px]"
                onClick={clearCompleted}
              >
                <Trash2Icon data-icon="inline-start" className="size-3" />
                {t("downloads.clearDone")}
              </Button>
            )}
          </div>
          {/* scrollbarVisibility="always"：默认 hover 才显示滑轨，用户看不出还能往下拉
              （历史记录一屏放不下）。列表类弹层要常驻滚动条。 */}
          <ScrollArea scrollbarVisibility="always" className="h-[min(20rem,calc(100vh-8rem))] min-h-0">
            <div className="flex flex-col gap-2 p-2">
              {groups.length === 0 ? (
                <div className="flex flex-col items-center gap-1.5 py-10 text-center">
                  <DownloadCloudIcon className="size-6 text-muted-foreground/40" />
                  <p className="text-xs text-muted-foreground">{t("downloads.empty")}</p>
                </div>
              ) : (
                groups.map((group) => <ModelRow key={group.key} group={group} />)
              )}
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  );
}
