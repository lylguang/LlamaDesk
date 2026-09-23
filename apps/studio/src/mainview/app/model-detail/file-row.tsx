import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DownloadIcon, CheckCircle2Icon, Loader2Icon, AlertTriangleIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Badge } from "@ui/badge";
import { useT } from "@stores/ui-lang";
import { MODEL_SOURCE_META, engineSupports, fileBaseName, type MarketFile, type ModelSource } from "../../../shared/modelscope";
import { ModelFormatBadge } from "@components/model-category-badge";
import { installedFilesForRepo } from "@/mainview/lib/installed-models";
import { formatBytes } from "./parts";

/**
 * 模型文件清单的一行 —— **只是清单**：文件名、格式、大小、装没装。
 *
 * 进度、速度、剩余时间、排队位置、暂停/重试都不在这里：下载的单元是整个模型
 * （见 ModelDownloadCard），逐个文件挂一条进度条会把「这个模型下了多少」淹掉。
 * 唯一的例外是 GGUF：每个量化是能独立跑的模型，所以仍保留它自己那一个下载按钮。
 */
export function FileRow({
  file,
  repo,
  source,
  category,
  engine,
}: {
  file: MarketFile;
  repo: string;
  /** 列文件与下载走同一个平台：这里的来源就是下载来源。 */
  source: ModelSource;
  category: import("../../../shared/modelscope").ModelCategory;
  engine: import("../../../shared/modelscope").InferenceEngine;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const installedModels = useQuery({
    queryKey: ["installed-models"],
    queryFn: () => rpcClient.listInstalledModels(),
  });

  // 已安装列表存的是文件名，仓库里的文件可能是 `BF16/xxx.gguf` 这样的子目录路径；
  // 整仓库条目（一个仓库一条记录）的成员文件在 `files` 里，由 installedFilesForRepo 摊平。
  // 按仓库比对：别的仓库里的同名分片不算这个文件已下载（见该函数注释）。
  const installedPaths = installedFilesForRepo(installedModels.data?.models ?? [], repo);
  const isInstalledHere = installedPaths.has(fileBaseName(file.name));

  const startMutation = useMutation({
    mutationFn: () =>
      rpcClient.startModelDownload({
        repo,
        fileName: file.name,
        category,
        source,
        // 用户单独点的这一个：带上体积用于排队，并显式插队（不排在批量小文件后面）。
        size: file.size,
        explicit: true,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["model-downloads"] }),
  });

  return (
    <div className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate font-mono text-xs">{file.name}</p>
          <ModelFormatBadge
            kind={file.kind}
            label={
              file.kind === "gguf"
                ? t("models.format.gguf")
                : file.kind === "safetensors"
                  ? t("models.format.safetensors")
                  : t("models.format.other")
            }
            className="h-4 px-1 text-[9px]"
          />
          {!engineSupports(engine, file.kind) && (
            <span className="inline-flex h-4 shrink-0 items-center gap-0.5 rounded bg-amber-100 px-1 text-[9px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
              <AlertTriangleIcon className="size-2.5" />
              {t("models.incompatible")}
            </span>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">{formatBytes(file.size)}</p>
      </div>

      {isInstalledHere ? (
        <Badge variant="secondary" className="shrink-0 text-[10px]">
          <CheckCircle2Icon className="size-3" /> {t("models.downloaded")}
        </Badge>
      ) : file.kind === "gguf" ? (
        // GGUF：一个文件就是一个可独立运行的模型，保留单独下载（进度在下载面板里看）。
        <Button
          variant="outline"
          size="sm"
          className="h-7 shrink-0 text-xs"
          disabled={startMutation.isPending}
          onClick={() => startMutation.mutate()}
        >
          {startMutation.isPending ? (
            <Loader2Icon data-icon="inline-start" className="animate-spin" />
          ) : (
            <DownloadIcon data-icon="inline-start" />
          )}
          {t("market.downloadFrom", { source: MODEL_SOURCE_META[source].label })}
        </Button>
      ) : null}
    </div>
  );
}
