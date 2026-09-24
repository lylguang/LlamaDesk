import { type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  MessageCircleDashedIcon,
  SquareTerminalIcon,
  PhoneIcon,
  AudioWaveformIcon,
  ShapesIcon,
  ClapperboardIcon,
  MusicIcon,
  ScanSearchIcon,
  EarthIcon,
  WandSparklesIcon,
  BlocksIcon,
  LibraryIcon,
  BrainIcon,
  GaugeIcon,
  LayoutGridIcon,
  SlidersHorizontalIcon,
  PanelLeftIcon,
  PanelLeftCloseIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@ui/tooltip";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@stores/router";
import { useAppStore, type AppId } from "@stores/app";
import { useChatStore } from "@stores/chat";
import { useAgentStore } from "@stores/agent";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import {
  APP_RAIL_EXPANDED_KEY,
  APP_RAIL_LAYOUT_KEY,
  resolveRailLayout,
  visibleRailEntries,
} from "@/shared/app-rail";

/** 侧边栏展开/收起的切换按钮（放在内容区 header 左侧，避开 macOS 窗口控制按钮）。 */
export function RailToggleButton() {
  const t = useT();
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  const expanded = data?.settings?.[APP_RAIL_EXPANDED_KEY] === "1";

  const toggle = () => {
    const next = expanded ? "" : "1";
    rpcClient.updateSettings({ settings: { [APP_RAIL_EXPANDED_KEY]: next } }).then(() => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    });
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={t("nav.toggleRail")}
          onClick={toggle}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {expanded ? (
            <PanelLeftCloseIcon className="size-4" />
          ) : (
            <PanelLeftIcon className="size-4" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {t("nav.toggleRail")}
      </TooltipContent>
    </Tooltip>
  );
}

// 抽象几何风格图标，区别于参考原型（气泡/麦克风/风景画）的具象图标。
// 导出给设置 → 外观 的菜单配置卡复用 —— 配置里看到的图标必须就是菜单里那个。
export const APP_ICONS: Record<AppId, ReactNode> = {
  chat: <MessageCircleDashedIcon className="size-5" />,
  agent: <SquareTerminalIcon className="size-5" />,
  // JEV：滑杆 == "在档位/选项上做判定"，与 Agent 的终端方块、其它具象图标区分开
  jev: <SlidersHorizontalIcon className="size-5" />,
  voicecall: <PhoneIcon className="size-5" />,
  voice: <AudioWaveformIcon className="size-5" />,
  image: <ShapesIcon className="size-5" />,
  video: <ClapperboardIcon className="size-5" />,
  music: <MusicIcon className="size-5" />,
  ocr: <ScanSearchIcon className="size-5" />,
  translate: <EarthIcon className="size-5" />,
  prompt: <WandSparklesIcon className="size-5" />,
  skills: <BlocksIcon className="size-5" />,
  kb: <LibraryIcon className="size-5" />,
  memory: <BrainIcon className="size-5" />,
  benchmark: <GaugeIcon className="size-5" />,
  // 小应用中心：九宫格 == "一堆小格子点进去"，与其它具象图标区分开
  apps: <LayoutGridIcon className="size-5" />,
};

function RailButton({
  active,
  label,
  onClick,
  expanded,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  expanded: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          className={cn(
            "flex h-10 items-center gap-2.5 rounded-xl transition-colors",
            expanded ? "w-full px-3" : "size-10 justify-center",
            active
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {children}
          {expanded && <span className="flex-1 truncate text-left text-sm">{label}</span>}
        </button>
      </TooltipTrigger>
      {!expanded && (
        <TooltipContent side="right" sideOffset={8}>
          {label}
        </TooltipContent>
      )}
    </Tooltip>
  );
}

export function AppRail() {
  const t = useT();
  const route = useRouter((s) => s.route);
  const setRoute = useRouter((s) => s.setRoute);
  const activeApp = useAppStore((s) => s.activeApp);
  const setActiveApp = useAppStore((s) => s.setActiveApp);

  // 顺序与显示 / 隐藏由「设置 → 外观 → 左侧一级菜单」决定（`APP_RAIL_LAYOUT`）。
  // 设置页改完 invalidate 这个 query，菜单立刻跟着变，不需要重启。
  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  const items = visibleRailEntries(resolveRailLayout(data?.settings?.[APP_RAIL_LAYOUT_KEY]));
  const expanded = data?.settings?.[APP_RAIL_EXPANDED_KEY] === "1";

  const onMainRoute = route.path === "index" || route.path === "chat";
  const inSettings = route.path === "settings";

  const handleSelect = (app: AppId) => {
    if (onMainRoute && activeApp === app) return;
    setActiveApp(app);
    useChatStore.getState().setActiveConversation(null);
    useChatStore.getState().setActiveMessages([]);
    useChatStore.getState().setStreaming(false);
    useAgentStore.getState().clear();
    setRoute({ path: "index" });
  };

  return (
    <TooltipProvider delayDuration={300}>
      <nav
        aria-label="App rail"
        className={cn(
          "flex shrink-0 flex-col items-center gap-1.5 border-r bg-muted/40 pb-3 transition-[width] duration-200 ease-out",
          expanded ? "w-[200px] px-2" : "w-12 px-0",
        )}
      >
        <div className="electrobun-webkit-app-region-drag h-10 w-full shrink-0" />
        {items.map(({ id: app }) => (
          <RailButton
            key={app}
            active={onMainRoute && activeApp === app}
            label={t(`apps.${app}`)}
            onClick={() => handleSelect(app)}
            expanded={expanded}
          >
            {APP_ICONS[app]}
          </RailButton>
        ))}
        <div className="mt-auto">
          <RailButton
            active={inSettings}
            label={t("nav.settings")}
            onClick={() => setRoute({ path: "settings" })}
            expanded={expanded}
          >
            <SlidersHorizontalIcon className="size-5" />
          </RailButton>
        </div>
      </nav>
    </TooltipProvider>
  );
}
