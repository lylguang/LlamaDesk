import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DownloadIcon,
  CheckCircle2Icon,
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Badge } from "@ui/badge";
import { useModelDownloadStore } from "@stores/model-download";
import { useT } from "@stores/ui-lang";
import { MODEL_SOURCE_META, fileBaseName, isMmprojFileName, type MarketFile, type ModelSource } from "../../../shared/modelscope";
import { installedFilesForRepo } from "@/mainview/lib/installed-models";
import {
  dedupeByFile,
  formatBytes,
  formatEta,
  modelGroupStatus,
  summarizeModelDownload,
} from "@lib/download-view";
import type { DownloadTask } from "../../../bun/download-manager";
import { sortBySizeAsc } from "./parts";

/**
 * 整个模型的下载卡：**一个模型一个进度、一个主按钮**。
 *
 * safetensors / MLX 这类整仓库模型的十几个分片 + config + tokenizer 必须一起下完
 * 才能加载，所以用户要的进度是「这个模型下了多少」，不是一个文件一条进度条。
 * 底层任务仍然是文件级的（断点续传、分片重试都在那一层），这里只盯着这张卡要下
 * 的那几个文件，把它们的任务聚合成一条。
 *
 * GGUF 仓库的每个量化是能独立跑的模型，`targets` 因此退化成单个文件。
 */
/**
 * 还没排过队的文件在卡片上要占一行：分母来自市场清单（体积已知），分子是 0。
 * 只用于 `summarizeModelDownload` 的统计，不参与任何按钮的任务操作。
 */
function placeholderTask(repo: string, file: MarketFile, source: ModelSource): DownloadTask {
  return {
    id: `pending:${file.name}`,
    repo,
    fileName: file.name,
    source,
    status: "queued",
    received: 0,
    total: file.size,
    percent: 0,
    speed: 0,
    createdAt: 0,
    size: file.size,
    order: 0,
  };
}

export function ModelDownloadCard({
  repo,
  file,
  source,
  category,
  repoFiles,
}: {
  repo: string;
  file: MarketFile;
  source: ModelSource;
  category: import("../../../shared/modelscope").ModelCategory | null;
  /** 非 GGUF：整仓库一起下（分片 + config/tokenizer），否则引擎加载不了。 */
  repoFiles: MarketFile[];
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const tasks = useModelDownloadStore((s) => s.tasks);
  const installed = useQuery({
    queryKey: ["installed-models"],
    queryFn: () => rpcClient.listInstalledModels(),
  });
  // 按仓库比对："已下载"必须是**这个仓库**的权重与配置文件都在本地，
  // 别的仓库里有同名分片不算数（否则会直接把这张卡显示成已下载、跳过真正的权重）。
  const installedNames = installedFilesForRepo(installed.data?.models ?? [], repo);

  // GGUF 仓库的每个量化是能独立跑的模型，`targets` 因此退化成单个文件 ——
  // **但要带上投影文件（mmproj）**：多模态 GGUF 的视觉塔就装在这个独立文件里，
  // 只下权重的话模型起得来、纯文本也正常，一上传图片就会被服务端拒（现场就是
  // 「提示缺 mmproj，可文件明明下过了」）。它是这张卡的一部分，不是仓库里另一件事。
  const projectors = repoFiles.filter((f) => f.kind === "gguf" && isMmprojFileName(f.name));
  const singleFile = file.kind === "gguf";
  const targets = singleFile
    ? [file, ...projectors.filter((p) => fileBaseName(p.name) !== fileBaseName(file.name))]
    : repoFiles.length > 0
      ? repoFiles
      : [file];
  const isInstalled = targets.every((f) => installedNames.has(fileBaseName(f.name)));
  // 还缺哪些：已下好的文件不再排一次队（同仓库的量化与投影文件可能一半已在盘上，
  // 「补队列」只该补真正缺的），进度分母也按「还缺的」算，不该被已下好的拉低。
  const wanted = targets.filter((f) => !installedNames.has(fileBaseName(f.name)));

  // 只看这张卡要下的那几个文件的任务：同一个仓库里别的量化在下载不该算进来。
  // 同名的多条任务按「进展最靠前」留一条：失败后重下会留下「旧的 failed + 新的
  // completed」两条，不去重会让模型永远顶着「失败」（与下载面板同一套口径）。
  const targetNames = new Set(wanted.map((f) => f.name));
  const relevant = dedupeByFile(
    tasks.filter((task) => task.repo === repo && targetNames.has(task.fileName)),
  );
  // 从没排过队的文件：磁盘上还有没下的权重（别的仓库里的同名分片不算数，见
  // installedFilesForRepo），而任务列表里根本没有它 —— 陈旧的失败卡片就是这种现场，
  // 光点「重试失败的文件」永远补不齐，模型也就一直跑不起来。
  const missing = wanted.filter((f) => !relevant.some((task) => task.fileName === f.name));
  // 进度按「这个模型要下的全部文件」算：缺的文件按 0 计入分子、按市场给的体积计入分母，
  // 否则一张半拉子卡片会显示成快下完了。
  const all = [...relevant, ...missing.map((f) => placeholderTask(repo, f, source))];
  const summary = summarizeModelDownload(all);
  const status = relevant.length > 0 ? modelGroupStatus(relevant) : null;
  const failedCount = relevant.filter((task) => task.status === "failed").length;
  const doneCount = all.filter((task) => task.status === "completed").length;
  const eta = status === "downloading" ? formatEta(summary.remainingBytes, summary.speed, t) : null;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["model-downloads"] });
  const start = useMutation({
    mutationFn: async () => {
      // 整仓库下载带全量清单（含已下完的文件）：manifest 是仓库级完整清单，
      // 完成比对才拿得出「缺哪些」。
      const manifestFiles = targets.map((f) => ({ path: f.path, name: f.name, size: f.size }));
      for (const f of sortBySizeAsc(wanted)) {
        await rpcClient.startModelDownload({
          repo,
          fileName: f.name,
          category: category ?? undefined,
          source,
          size: f.size,
          manifestFiles,
        });
      }
    },
    onSuccess: invalidate,
  });
  const pause = useMutation({
    mutationFn: async () => {
      for (const task of relevant) {
        if (task.status === "downloading") await rpcClient.pauseModelDownload({ id: task.id });
      }
    },
    onSuccess: invalidate,
  });
  const resume = useMutation({
    // scope: "failed" 只挑失败的文件重试（其余还在下的不打扰）；"all" 恢复暂停的。
    mutationFn: async (scope: "all" | "failed") => {
      for (const task of relevant) {
        const hit = scope === "failed" ? task.status === "failed" : task.status === "paused";
        if (hit) await rpcClient.resumeModelDownload({ id: task.id });
      }
    },
    onSuccess: invalidate,
  });
  // 「把没下完的都补上」：失败的文件接着下 + 从没排过队的文件补进队列。一次点击，
  // 不用先判断自己缺的是哪一种 —— 用户要的是「这个模型能跑」，不是分清失败与缺失。
  const complete = useMutation({
    mutationFn: async () => {
      for (const task of relevant) {
        if (task.status === "failed") await rpcClient.resumeModelDownload({ id: task.id });
      }
      for (const f of sortBySizeAsc(missing)) {
        await rpcClient.startModelDownload({
          repo,
          fileName: f.name,
          category: category ?? undefined,
          source,
          size: f.size,
          manifestFiles: targets.map((f) => ({ path: f.path, name: f.name, size: f.size })),
        });
      }
    },
    onSuccess: invalidate,
  });
  const cancel = useMutation({
    mutationFn: async () => {
      for (const task of relevant) {
        if (task.status === "downloading" || task.status === "queued" || task.status === "paused") {
          await rpcClient.cancelModelDownload({ id: task.id });
        }
      }
    },
    onSuccess: invalidate,
  });

  const busy =
    start.isPending || pause.isPending || resume.isPending || cancel.isPending || complete.isPending;
  const acting = status === "downloading" || status === "queued" || status === "paused" || status === "failed";

  if (isInstalled) {
    return (
      <Badge variant="default" className="h-8 gap-1.5 px-3 text-xs">
        <CheckCircle2Icon className="size-4" />
        {t("models.downloaded")} · {singleFile ? file.name : repo}
      </Badge>
    );
  }

  if (!acting) {
    return (
      <Button size="sm" disabled={start.isPending} onClick={() => start.mutate()}>
        {start.isPending ? (
          <Loader2Icon data-icon="inline-start" className="animate-spin" />
        ) : (
          <DownloadIcon data-icon="inline-start" />
        )}
        {singleFile
          ? `${t("market.downloadFrom", { source: MODEL_SOURCE_META[source].label })} · ${file.name}`
          : t("models.downloadRepoSet", { count: String(targets.length) })}
      </Button>
    );
  }

  return (
    <div className="flex w-full max-w-xl flex-col gap-1.5 rounded-lg border bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-2 text-[11px] tabular-nums text-muted-foreground">
        <span className="truncate">
          {status === "failed"
            ? t(`downloads.status.failed`)
            : status === "paused"
              ? t(`downloads.status.paused`)
              : t(`downloads.status.${status}`)}
          <span className="ml-1.5">
            {t("downloads.groupFiles", {
              done: String(doneCount),
              total: String(relevant.length),
            })}
          </span>
        </span>
        <span className="shrink-0">{summary.percent != null ? `${summary.percent}%` : "…"}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300"
          style={{ width: `${summary.percent ?? 0}%` }}
        />
      </div>
      <p className="text-[10px] tabular-nums text-muted-foreground">
        {summary.percent != null
          ? `${formatBytes(summary.received)} / ${formatBytes(summary.total)}`
          : formatBytes(summary.received)}
        {summary.speed > 0 ? ` · ${formatBytes(summary.speed)}/s` : ""}
        {eta ? ` · ${eta}` : ""}
      </p>
      {failedCount > 0 && (
        <p className="text-[10px] text-destructive">
          {t("downloads.groupFailed", { n: String(failedCount) })}
        </p>
      )}
      <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
        {status === "downloading" && (
          <Button variant="outline" size="sm" className="h-7 text-xs" disabled={busy} onClick={() => pause.mutate()}>
            <PauseIcon data-icon="inline-start" className="size-3" />
            {t("downloads.pause")}
          </Button>
        )}
        {status === "paused" && (
          <Button variant="outline" size="sm" className="h-7 text-xs" disabled={busy} onClick={() => resume.mutate("all")}>
            <PlayIcon data-icon="inline-start" className="size-3" />
            {t("downloads.resume")}
          </Button>
        )}
        {failedCount + missing.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={busy}
            onClick={() => complete.mutate()}
          >
            <RotateCcwIcon data-icon="inline-start" className="size-3" />
            {missing.length > 0
              ? t("models.continueDownload", { n: String(failedCount + missing.length) })
              : t("models.retryFailedFiles", { n: String(failedCount) })}
          </Button>
        )}
        <Button variant="ghost" size="sm" className="h-7 text-xs" disabled={busy} onClick={() => cancel.mutate()}>
          <XIcon data-icon="inline-start" className="size-3" />
          {t("downloads.cancel")}
        </Button>
      </div>
    </div>
  );
}
