import { useQuery } from "@tanstack/react-query";
import { DownloadIcon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { useEngine } from "@lib/use-engine";
import { Button } from "@ui/button";
import { useT } from "@stores/ui-lang";
import { InstalledModels, ModelsEmptyState } from "../local-models/installed";

/**
 * 「本地已下载」页签：本机有哪些模型、从哪儿来的、跑哪个引擎。
 *
 * 一台机器上没装模型是最常见的第一种状态，所以空态直说「本地还没有模型」并给一条去
 * 模型市场的路（切到隔壁页签，不是把人丢到别的页面）。
 */
export function DownloadedTab({ onOpenMarket }: { onOpenMarket: () => void }) {
  const t = useT();
  const { engine } = useEngine();
  const { data } = useQuery({
    queryKey: ["installed-models"],
    queryFn: () => rpcClient.listInstalledModels(),
  });

  if ((data?.models ?? []).length === 0) {
    return (
      <ModelsEmptyState
        title={t("library.localEmpty")}
        hint={t("library.localEmptyHint")}
        action={
          <Button variant="outline" size="sm" onClick={onOpenMarket}>
            <DownloadIcon data-icon="inline-start" className="size-3.5" />
            {t("library.goMarket")}
          </Button>
        }
      />
    );
  }

  // 全列（含当前引擎跑不了的，行上会标「将自动切换引擎」）：
  // 按引擎严格过滤会让切一次引擎就有模型从列表里消失。
  return <InstalledModels engine={engine} allEngines />;
}
