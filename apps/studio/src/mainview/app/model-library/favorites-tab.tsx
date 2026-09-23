import { StarIcon } from "lucide-react";

import { useEngine } from "@lib/use-engine";
import { useT } from "@stores/ui-lang";
import { InstalledModels } from "../local-models/installed";

/**
 * 「我的收藏」页签：本机模型里点过星标的那些。
 *
 * 收藏是跨引擎、跨来源的一份清单（模型在哪个目录、用哪个引擎跑都不重要），
 * 所以这里既不过滤引擎也不摆来源筛选 —— 一排动作（运行 / 激活 / 复制命令）都还在。
 */
export function FavoritesTab() {
  const t = useT();
  const { engine } = useEngine();

  return (
    <div className="flex flex-col gap-3">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <StarIcon className="size-4 text-amber-500" />
        {t("library.favorites")}
      </h3>
      <p className="text-[11px] text-muted-foreground">{t("library.favoritesHint")}</p>
      <InstalledModels
        engine={engine}
        favoritesOnly
        emptyTitle={t("library.favoritesEmpty")}
        emptyHint={t("library.favoritesEmptyHint")}
      />
    </div>
  );
}
