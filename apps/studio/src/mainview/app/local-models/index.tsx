import { useQuery } from "@tanstack/react-query";
import { CpuIcon, DownloadIcon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { useEngine } from "@lib/use-engine";
import { Button } from "@ui/button";
import { ScrollArea } from "@ui/scroll-area";
import { PageShell } from "@components/setting-ui";
import { useT } from "@stores/ui-lang";
import { EngineSelector } from "./engine-selector";
import { ServerParamsPanel } from "./params";
import { LaunchBar } from "./launch-bar";
import { DefaultModelConfig } from "./defaults";

// ---------------------------------------------------------------------------
// 运行模型：把本机模型跑起来的那一页（模型本身在「模型库」）
// ---------------------------------------------------------------------------

/**
 * 运行模型：模型引擎 / 启动参数 / 启动条 / 默认模型与目录。
 *
 * 模型清单不在这里（在「模型库 → 本地已下载」，每行自带运行 / 激活）——
 * 同一份列表摆两处，只会让人不确定该在哪一处操作。这里只管"怎么跑"。
 * 一个模型都没有时给一条去模型库的路：这台机器上"跑不起来"最常见的原因就是还没有模型。
 */
export function RunModelsScreen({ onOpenLibrary }: { onOpenLibrary?: () => void } = {}) {
  const t = useT();
  const { engine } = useEngine();
  const { data } = useQuery({
    queryKey: ["installed-models"],
    queryFn: () => rpcClient.listInstalledModels(),
  });
  const hasModels = (data?.models ?? []).length > 0;

  return (
    <ScrollArea className="h-full">
      <PageShell>
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <CpuIcon className="size-5" />
            {t("run.title")}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">{t("run.subtitle")}</p>
        </div>

        {!hasModels && (
          <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed p-4">
            <p className="text-xs font-medium">{t("library.localEmpty")}</p>
            <p className="text-[11px] leading-5 text-muted-foreground">
              {t("library.localEmptyHint")}
            </p>
            {onOpenLibrary && (
              <Button variant="outline" size="sm" onClick={onOpenLibrary}>
                <DownloadIcon data-icon="inline-start" className="size-3.5" />
                {t("run.goLibrary")}
              </Button>
            )}
          </div>
        )}

        <EngineSelector />
        <ServerParamsPanel engine={engine} />
        <LaunchBar installedModels={data?.models ?? []} engine={engine} />
        <DefaultModelConfig />
      </PageShell>
    </ScrollArea>
  );
}
