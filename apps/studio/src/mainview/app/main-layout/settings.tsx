import { useState, useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BlocksIcon,
  GlobeIcon,
  TerminalSquareIcon,
  TerminalIcon,
  LayoutDashboardIcon,
  BoxIcon,
  CpuIcon,
  ServerIcon,
  CircuitBoardIcon,
  CloudIcon,
  WaypointsIcon,
  GithubIcon,
  PlugIcon,
  ShieldIcon,
  PaletteIcon,
  ArchiveIcon,
  SparklesIcon,
  SlidersHorizontalIcon,
  StarIcon,
  ChartColumnIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { ScrollArea } from "@ui/scroll-area";
import { PageShell } from "@components/setting-ui";
import { IntegrationsSettings } from "./integrations-tab";
import { AboutTab } from "./about-tab";
import { WebSearchTab } from "./web-search-tab";
import { McpTab } from "./mcp-tab";
import { AppearanceTab } from "./prefs-tabs";
import { GeneralTab } from "./general-tab";
import { CliTab } from "./cli-tab";
import { BackupTab } from "./backup-tab";
import { EnginesTab } from "./engines-tab";
import { PermissionsTab } from "./permissions-tab";
import { AgentCapsTab } from "./agent-caps-tab";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import { DashboardScreen } from "../dashboard-screen";
import { UsageScreen } from "../usage-screen";
import { ConsoleScreen } from "./console-screen";
import { ModelDetailScreen } from "../model-detail";
import { RunModelsScreen } from "../local-models";
import { CloudProviderPanel } from "./cloud-provider-panel";
import { DefaultModelsPanel } from "./default-models-panel";
import { TunnelScreen } from "../tunnel-screen";
import { GatewayScreen } from "../gateway-screen";
import {
  DEFAULT_LIBRARY_TAB,
  ModelLibraryScreen,
  isLibraryTab,
  type LibraryTab,
} from "../model-library";
import { useModelDetailStore, type ModelDetailSource } from "@stores/model-detail";
import { useRouter } from "@stores/router";

type SettingsFormState = Record<string, string>;

type SettingsTab =
  | "library"
  | "run"
  | "cloud"
  | "defaults"
  | "engines"
  | "gateway"
  | "tunnel"
  | "integrations"
  | "logs"
  | "usage"
  | "stats"
  | "websearch"
  | "mcp"
  | "permissions"
  | "agentcaps"
  | "cli"
  | "backup"
  | "general"
  | "appearance"
  | "about";

const TAB_DEFS: Record<SettingsTab, { icon: ReactNode; labelKey: string }> = {
  library: { icon: <BoxIcon className="size-4" />, labelKey: "library.title" },
  run: { icon: <CpuIcon className="size-4" />, labelKey: "run.title" },
  cloud: { icon: <ServerIcon className="size-4" />, labelKey: "cloud.title" },
  defaults: { icon: <StarIcon className="size-4" />, labelKey: "defaults.title" },
  engines: { icon: <CircuitBoardIcon className="size-4" />, labelKey: "settings.engines.title" },
  gateway: { icon: <WaypointsIcon className="size-4" />, labelKey: "settings.gateway" },
  tunnel: { icon: <CloudIcon className="size-4" />, labelKey: "settings.tunnel" },
  integrations: { icon: <BlocksIcon className="size-4" />, labelKey: "settings.integrations" },
  logs: { icon: <TerminalSquareIcon className="size-4" />, labelKey: "console.title" },
  usage: { icon: <ChartColumnIcon className="size-4" />, labelKey: "settings.usage.title" },
  stats: { icon: <LayoutDashboardIcon className="size-4" />, labelKey: "settings.dashboard" },
  websearch: { icon: <GlobeIcon className="size-4" />, labelKey: "settings.webSearch.title" },
  mcp: { icon: <PlugIcon className="size-4" />, labelKey: "settings.mcp.title" },
  permissions: { icon: <ShieldIcon className="size-4" />, labelKey: "settings.permissions.title" },
  agentcaps: { icon: <SparklesIcon className="size-4" />, labelKey: "settings.agentCaps.title" },
  cli: { icon: <TerminalIcon className="size-4" />, labelKey: "settings.cli.title" },
  backup: { icon: <ArchiveIcon className="size-4" />, labelKey: "settings.backup.title" },
  general: { icon: <SlidersHorizontalIcon className="size-4" />, labelKey: "settings.general.title" },
  appearance: { icon: <PaletteIcon className="size-4" />, labelKey: "settings.appearance" },
  about: { icon: <GithubIcon className="size-4" />, labelKey: "settings.aboutTab.title" },
};

/**
 * 设置导航分组（参照主流客户端的设置页：分组标题 + 条目）。
 *
 * 首组无标题：概览（这个应用现在在跑什么）+ 通用 / 外观（这个应用长什么样、走不走代理）
 * 同属"打开就能看、顺手就能改"的一层，再套一个标题只是噪声。
 * 末尾的「系统」只有关于我们一条：版本 / 更新 / 开源信息是查的，不是调的，
 * 混在可改的设置里反而找不到。
 */
const TAB_GROUPS: { labelKey?: string; tabs: SettingsTab[] }[] = [
  { tabs: ["stats", "general", "appearance"] },
  {
    labelKey: "settings.group.models",
    // 模型这一组五条，各管一段：有哪些模型（模型库）/ 怎么跑（运行模型）/
    // 用云端 API（云端模型）/ 各场景默认用哪个（默认模型）/ 引擎本体的安装升级（模型引擎）。
    tabs: ["library", "run", "cloud", "defaults", "engines"],
  },
  {
    labelKey: "settings.group.services",
    tabs: ["gateway", "tunnel", "integrations"],
  },
  { labelKey: "settings.group.tools", tabs: ["websearch", "mcp", "permissions", "agentcaps", "cli"] },
  { labelKey: "settings.group.data", tabs: ["usage", "logs", "backup"] },
  { labelKey: "settings.group.system", tabs: ["about"] },
];

/**
 * 旧标签 id → 现归属。模型组这轮改过名也挪过位置，外部跳转却还在用旧 id：
 * 小应用 `omni.openSettings("network")`、CLI navigate 的 `models`、各式错误回退。
 * 这里映射一次，旧 id 不会落到空白页。
 *
 *   network（模型云服务）→ 云端模型（`defaults` 现在是独立页签，不再走这里）
 *   model（本地模型）     → 运行模型
 *   store（模型库）       → 模型库（默认页签）
 *   market（在线模型市场）→ 模型库 → 模型市场页签
 */
const LEGACY_TABS: Record<string, { tab: SettingsTab; libraryTab?: LibraryTab }> = {
  network: { tab: "cloud" },
  model: { tab: "run" },
  store: { tab: "library" },
  market: { tab: "library", libraryTab: "market" },
};

/** 解析路由里的标签：认新 id，也认旧 id；非模型页签不带模型库子页签。 */
function resolveRouteTab(
  raw: string | undefined,
  sub: string | undefined,
): { tab: SettingsTab; libraryTab?: LibraryTab } | null {
  if (!raw) return null;
  if (raw in TAB_DEFS) {
    const tab = raw as SettingsTab;
    if (tab !== "library") return { tab };
    return { tab, libraryTab: isLibraryTab(sub) ? sub : DEFAULT_LIBRARY_TAB };
  }
  const legacy = LEGACY_TABS[raw];
  if (!legacy) return null;
  return {
    tab: legacy.tab,
    libraryTab: isLibraryTab(sub) ? sub : legacy.libraryTab,
  };
}

/** 自带头部（PageHeader / 宽版面板）的页面不再重复显示通用标题。 */
const SELF_HEADED_TABS: SettingsTab[] = [
  "library",
  "run",
  "cloud",
  "defaults",
  "about",
  "websearch",
  "mcp",
  "permissions",
  "agentcaps",
  "cli",
  "backup",
  "general",
  "appearance",
  "tunnel",
  "engines",
];

/** 设置页：一级页面，每个标签页的内容宽度统一由 `PageShell` 决定。 */
export function SettingsScreen() {
  const t = useT();
  const [activeTab, setActiveTab] = useState<SettingsTab>("stats");
  const [libraryTab, setLibraryTab] = useState<LibraryTab>(DEFAULT_LIBRARY_TAB);
  const [form, setForm] = useState<SettingsFormState>({});
  // 设置页内原地打开的模型详情：不切换全局路由，左侧分类菜单保持可见。
  const [detail, setDetail] = useState<ModelDetailSource | null>(null);
  const openDetail = (source: ModelDetailSource) => {
    useModelDetailStore.getState().setSource(source);
    setDetail(source);
  };
  const pickTab = (tab: SettingsTab) => {
    // 从别的菜单点进模型库才回到默认页签；本来就在库里点它，别把人从当前页签踢走。
    if (tab === "library" && activeTab !== "library") setLibraryTab(DEFAULT_LIBRARY_TAB);
    setActiveTab(tab);
    setDetail(null);
  };
  /** 跳到模型库并指定页签（运行模型页的空态走这条）。 */
  const openLibrary = (sub: LibraryTab) => {
    pickTab("library");
    setLibraryTab(sub);
  };

  // 外部跳转（CLI / OCR / 错误回退 / 小应用）带 tab / sub 参数时切到对应标签。
  const routeTab = useRouter((s) => (s.route.path === "settings" ? s.route.tab : undefined));
  const routeSub = useRouter((s) => (s.route.path === "settings" ? s.route.sub : undefined));
  useEffect(() => {
    const target = resolveRouteTab(routeTab, routeSub);
    if (!target) return;
    setActiveTab((current) => (current === target.tab ? current : target.tab));
    if (target.libraryTab) {
      setLibraryTab((current) => (current === target.libraryTab ? current : target.libraryTab!));
    }
    setDetail(null);
  }, [routeTab, routeSub]);

  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });

  useEffect(() => {
    if (data?.settings) {
      const s = { ...data.settings };
      if (s.VLLM_API_KEY === "EMPTY") s.VLLM_API_KEY = "";
      setForm(s);
    }
  }, [data]);

  const updateField = (key: string, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="flex min-h-0 flex-1">
      {/* Left category nav：分组标题 + 条目 */}
      <nav
        aria-label={t("settings.title")}
        className="flex w-44 shrink-0 flex-col gap-1 overflow-y-auto border-r p-3"
      >
        {TAB_GROUPS.map((group) => (
          <div key={group.labelKey ?? group.tabs[0]} className="mb-1 flex flex-col gap-0.5">
            {group.labelKey && (
              <span className="mt-1 mb-0.5 px-2 text-[10px] font-medium tracking-wide text-muted-foreground/70 uppercase">
                {t(group.labelKey)}
              </span>
            )}
            {group.tabs.map((key) => {
              const tab = TAB_DEFS[key];
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => pickTab(key)}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs transition-colors",
                    activeTab === key
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {tab.icon}
                  <span className="truncate">{t(tab.labelKey)}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Right content: detail (opened in place) takes precedence over tab content */}
      {detail ? (
        <div className="min-w-0 flex-1">
          <ModelDetailScreen onBack={() => setDetail(null)} />
        </div>
      ) : activeTab === "library" ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ModelLibraryScreen
            tab={libraryTab}
            onTabChange={setLibraryTab}
            onOpenDetail={openDetail}
          />
        </div>
      ) : activeTab === "run" ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <RunModelsScreen onOpenLibrary={() => openLibrary("market")} />
        </div>
      ) : activeTab === "gateway" ? (
        <div className="min-w-0 flex-1">
          <GatewayScreen />
        </div>
      ) : activeTab === "tunnel" ? (
        <div className="min-w-0 flex-1">
          <TunnelScreen />
        </div>
      ) : activeTab === "stats" ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <DashboardScreen />
        </div>
      ) : activeTab === "usage" ? (
        // 使用统计是宽版仪表盘（热力图 + 三张图），与「概览」一样绕开通用窄栏。
        <ScrollArea className="min-h-0 min-w-0 flex-1">
          <UsageScreen />
        </ScrollArea>
      ) : activeTab === "logs" ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ConsoleScreen />
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <PageShell>
            {/* 自带头部（PageHeader / 宽版面板）的页面不再重复显示通用标题 */}
            {!SELF_HEADED_TABS.includes(activeTab) && (
              <div className="mb-6">
                <h2 className="text-lg font-semibold tracking-tight">{t("settings.title")}</h2>
                <p className="text-xs text-muted-foreground">{t("settings.subtitle")}</p>
              </div>
            )}

            {activeTab === "cloud" && <CloudProviderPanel />}

            {activeTab === "defaults" && <DefaultModelsPanel />}

            {/* 「管理模型 →」回到模型库的默认页签（本地已下载） */}
            {activeTab === "engines" && <EnginesTab onOpenModelsTab={() => pickTab("library")} />}

            {activeTab === "integrations" && (
              <IntegrationsSettings form={form} updateField={updateField} />
            )}

            {activeTab === "websearch" && (
              <WebSearchTab form={form} updateField={updateField} />
            )}

            {activeTab === "mcp" && <McpTab />}
            {activeTab === "permissions" && <PermissionsTab />}
            {activeTab === "agentcaps" && <AgentCapsTab />}

            {activeTab === "cli" && <CliTab />}

            {activeTab === "backup" && <BackupTab />}

            {activeTab === "general" && (
              <GeneralTab form={form} updateField={updateField} />
            )}

            {activeTab === "appearance" && (
              <AppearanceTab form={form} updateField={updateField} />
            )}

            {activeTab === "about" && <AboutTab />}
          </PageShell>
        </ScrollArea>
      )}
    </div>
  );
}

