import { useEffect, useRef, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { HardDriveIcon, StarIcon, StoreIcon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/tabs";
import { ScrollArea } from "@ui/scroll-area";
import { PAGE_WIDTH, PageShell } from "@components/setting-ui";
import { useT } from "@stores/ui-lang";
import type { ModelDetailSource } from "@stores/model-detail";
import { cn } from "@/mainview/lib/utils";
import { DownloadedTab } from "./downloaded-tab";
import { ModelMarketTab } from "./market-tab";
import { FavoritesTab } from "./favorites-tab";

// ---------------------------------------------------------------------------
// 模型库：模型本身只在这一页 —— 市场 / 已下载 / 收藏，横向页签切换
// ---------------------------------------------------------------------------

/** 页签顺序：市场（去哪儿下）→ 本地已下载（下到了什么）→ 我收藏的模型。 */
export const LIBRARY_TABS = ["market", "downloaded", "favorites"] as const;
export type LibraryTab = (typeof LIBRARY_TABS)[number];

/** 默认落在「本地已下载」：打开模型库的人多半是来看自己有什么模型的。 */
export const DEFAULT_LIBRARY_TAB: LibraryTab = "downloaded";

/** 路由 / 外部跳转带来的字符串是不是一个真页签。 */
export function isLibraryTab(value: string | undefined | null): value is LibraryTab {
  return !!value && (LIBRARY_TABS as readonly string[]).includes(value);
}

type TabDef = { value: LibraryTab; icon: ReactNode; labelKey: string };

/**
 * 模型库：模型本身的家 —— 在线模型市场（检索 / 下载）、本地已下载的模型、收藏的模型。
 *
 * 运行与配置不在这里：跑哪个引擎、启动参数在「运行模型」，云厂商与密钥在「云端模型」，
 * 引擎的安装升级卸载在「模型引擎」。这一页只管"有哪些模型、从哪儿下"。
 */
export function ModelLibraryScreen({
  tab,
  onTabChange,
  onOpenDetail,
}: {
  tab: LibraryTab;
  onTabChange: (tab: LibraryTab) => void;
  onOpenDetail?: (source: ModelDetailSource) => void;
}) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { data } = useQuery({
    queryKey: ["installed-models"],
    queryFn: () => rpcClient.listInstalledModels(),
  });
  const models = data?.models ?? [];
  const countOf = (value: LibraryTab) =>
    value === "downloaded"
      ? models.length
      : value === "favorites"
        ? models.filter((m) => m.favorite).length
        : 0;

  // 三个页签共用一条滚动轴：不回到顶部的话，从"翻到底的已下载"切到收藏页
  // 会停在一个短列表的中间。
  useEffect(() => {
    const viewport = scrollRef.current?.querySelector('[data-slot="scroll-area-viewport"]');
    if (viewport) viewport.scrollTop = 0;
  }, [tab]);

  const tabs: TabDef[] = [
    { value: "market", icon: <StoreIcon />, labelKey: "library.tab.market" },
    { value: "downloaded", icon: <HardDriveIcon />, labelKey: "library.tab.downloaded" },
    { value: "favorites", icon: <StarIcon />, labelKey: "library.tab.favorites" },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cn("mx-auto w-full shrink-0 px-6 pt-6", PAGE_WIDTH)}>
        <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <StoreIcon className="size-5" />
          {t("library.title")}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">{t("library.subtitle")}</p>
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) => onTabChange(value as LibraryTab)}
        className="flex min-h-0 flex-1 flex-col gap-0 pt-2"
      >
        {/* 页签排成一行、左右切换（不是竖排菜单） */}
        <div className={cn("mx-auto w-full shrink-0 border-b", PAGE_WIDTH)}>
          <TabsList variant="line" className="h-auto gap-1 rounded-none p-0 pb-1.5 pl-6">
            {tabs.map((item) => (
              <TabsTrigger key={item.value} value={item.value} className="gap-1.5 px-3 text-xs">
                {item.icon}
                {t(item.labelKey)}
                {countOf(item.value) > 0 && (
                  <span className="tabular-nums text-[10px] text-muted-foreground/70">
                    {countOf(item.value)}
                  </span>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <ScrollArea ref={scrollRef} className="min-h-0 flex-1">
          {/* 内容走 PageShell：与其它设置页同一个宽度，切页签时左右边缘不跳 */}
          <PageShell className="pt-5 pb-10">
            <TabsContent value="market">
              <ModelMarketTab onOpenDetail={onOpenDetail} />
            </TabsContent>
            <TabsContent value="downloaded">
              <DownloadedTab onOpenMarket={() => onTabChange("market")} />
            </TabsContent>
            <TabsContent value="favorites">
              <FavoritesTab />
            </TabsContent>
          </PageShell>
        </ScrollArea>
      </Tabs>
    </div>
  );
}
