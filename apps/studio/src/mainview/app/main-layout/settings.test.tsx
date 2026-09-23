import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 设置导航的回归测试。
 *
 * 两件事：
 *   1. 「通用」这一页在加进代理设置时**整页被删过一次**，页里的设置没跟着丢
 *      （更新通道 / 自动检查更新在「关于」页，启动时自动拉起推理服务搬到了服务器概览页）。
 *      现在它回来了 —— 承载代理设置 —— 这里锁住导航条目与点进去能渲染出代理卡；
 *   2. 概览页上那条自启动开关仍能改到设置。
 *
 * happy-dom 提供真实 DOM（Radix 的 Switch 需要），afterAll 还原全局。
 */
const dom = new Window({ url: "http://localhost/" });
const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "location",
  "history",
  "localStorage",
  "HTMLElement",
  "HTMLDivElement",
  "HTMLButtonElement",
  "HTMLInputElement",
  "Element",
  "Node",
  "Text",
  "DocumentFragment",
  "SVGElement",
  "DOMRect",
  "CustomElementRegistry",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
  "FocusEvent",
  "InputEvent",
  "MutationObserver",
  "ResizeObserver",
  "NodeFilter",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "getComputedStyle",
  "matchMedia",
] as const;
const savedGlobals = new Map<string, unknown>();
for (const key of DOM_GLOBALS) {
  const value = (dom as unknown as Record<string, unknown>)[key];
  if (value === undefined) continue;
  savedGlobals.set(key, (globalThis as unknown as Record<string, unknown>)[key]);
  (globalThis as unknown as Record<string, unknown>)[key] = value;
}
(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/** 每次 updateSettings 的补丁，用来确认开关真的写到了 AUTO_START_SERVER。 */
const settingsPatches: Record<string, string>[] = [];

mock.module("@lib/rpc", () => ({
  rpcClient: {
    getSettings: async () => ({ settings: {} }),
    getServerStats: async () => ({
      sessionStartedAt: Date.now(),
      serverStartedAt: 0,
      prefillTokens: 0,
      generationTokens: 0,
      requests: 0,
      prefillTokensPerSec: 0,
      generationTokensPerSec: 0,
      activeModels: [],
      // 概览页现在还会读这两个字段：整卡采样（读不到时带 reason）与逐实例显存。
      instances: [],
      gpu: { available: false as const, reason: "unified-memory" as const },
      system: {
        loadAvg: [0, 0, 0],
        totalMem: 16e9,
        freeMem: 8e9,
        disk: { total: 1e12, free: 5e11 },
      },
      modelsSize: 0,
    }),
    getServerStatus: async () => ({ status: "stopped" as const }),
    listServedModels: async () => ({ models: [] }),
    updateSettings: async ({ settings }: { settings: Record<string, string> }) => {
      settingsPatches.push(settings);
      return { settings: {} };
    },
    getProxyStatus: async () => ({
      mode: "system" as const,
      url: "",
      source: "none" as const,
      allowLocalNetwork: true,
      systemUrl: "",
      pacUrl: null,
      exceptions: [],
    }),
    testProxy: async () => ({ ok: true, url: "", source: "none" }),
    // 引擎页：空清单就够（这个测试只看导航与页面宽度，引擎行自己有 engines-tab.test.tsx）。
    listLocalEngines: async () => ({ engines: [] }),
    // 模型库 / 运行模型要用到的清单：都返回空，空态本身在 model-library 的用例里钉。
    listInstalledModels: async () => ({ models: [] }),
    getModelDirs: async () => ({ dirs: [] }),
    listChatModels: async () => ({ models: [] }),
    cloudProviderList: async () => ({ providers: [] }),
    searchMarketModels: async () => ({ models: [], total: 0, totalExact: true, hasMore: false }),
  },
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("@ui/tooltip");
const { SettingsScreen } = await import("./settings");
const { translate } = await import("../../../shared/i18n");

const zh = (key: string) => translate("zh", key);

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

async function renderSettings() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  await act(async () => {
    // 与 App 同款 Provider（components/providers.tsx）：本地模型 / 模型库的行内按钮
    // 挂了 Tooltip，缺 Provider 会直接抛错。
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TooltipProvider, null, createElement(SettingsScreen)),
      ),
    );
  });
  // 一拍给查询解析，一拍给渲染。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    text: document.body.textContent ?? "",
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

test("设置导航就是这一份：模型组是 模型库 / 运行模型 / 云端模型 / 默认模型 / 模型引擎，没有「性能」「记忆」这类重复入口", async () => {
  const { text, cleanup } = await renderSettings();
  const nav = document.querySelector("nav[aria-label]");
  expect(nav).not.toBeNull();
  const labels = [...nav!.querySelectorAll("button")].map((b) => b.textContent?.trim());
  expect(labels).toEqual([
    "概览",
    "通用",
    "外观",
    "模型库",
    "运行模型",
    "云端模型",
    "默认模型",
    "模型引擎",
    "网关",
    "远程访问",
    "集成",
    "联网检索",
    "MCP",
    "Agent 权限",
    "Agent 能力",
    "命令行",
    "使用统计",
    "控制台",
    "备份与恢复",
    "关于我们",
  ]);
  // 删掉的页面没有留下把 i18n key 原样渲染出来的残留。
  expect(text).not.toContain("settings.prefs.");
  await cleanup();
});

/**
 * 分组结构：首组（概览 / 通用 / 外观）不带标题，「关于我们」单独落在最底部的「系统」组。
 * 原来的「偏好」组解散 —— 通用 / 外观 上移跟着概览，关于我们下沉成只查不改的一条，
 * 别再把它们塞回一个组里。
 */
test("分组：首组无标题且是 概览 / 通用 / 外观，最底部的「系统」只有关于我们", async () => {
  const { cleanup } = await renderSettings();
  const nav = document.querySelector("nav[aria-label]");
  // 组的第一个元素子节点是标题 span（没有标题的组开头就是按钮）。
  const groups = Array.from(nav!.children).map((el) =>
    el.firstElementChild?.tagName === "SPAN" ? el.firstElementChild.textContent?.trim() : null,
  );
  expect(groups).toEqual([null, "模型", "服务", "工具", "数据", "系统"]);

  const top = nav!.children[0]!;
  expect([...top.querySelectorAll("button")].map((b) => b.textContent?.trim())).toEqual([
    "概览",
    "通用",
    "外观",
  ]);
  const last = nav!.children[nav!.children.length - 1]!;
  expect([...last.querySelectorAll("button")].map((b) => b.textContent?.trim())).toEqual(["关于我们"]);
  // 老的分组标题（i18n 键也一并删了）不会以任何形式留在菜单里。
  expect(nav!.textContent).not.toContain("偏好");
  expect(nav!.textContent).not.toContain("settings.group.prefs");
  await cleanup();
});

/**
 * 旧标签 id 不能变成空白页。
 *
 * 模型组这轮改过名也挪过位置（本地模型 → 运行模型、模型云服务 → 云端模型、在线模型市场
 * 收进模型库、默认模型从云端模型页里拆出来自成一条），外部跳转还在用旧 id：
 * 小应用 `omni.openSettings("network")`、CLI navigate 的 `models`、各式错误回退。
 * 这里钉住它们各自落到今天的那一页。
 */
test("旧标签 id 仍落在对应页面（network → 云端模型，defaults → 默认模型，model → 运行模型，market → 模型市场页签）", async () => {
  const { cleanup } = await renderSettings();
  const { useRouter } = await import("@stores/router");

  const routeTo = async (legacy: string) => {
    await act(async () => {
      useRouter.getState().setRoute({ path: "settings", tab: legacy });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const activeNav = () => {
    const nav = document.querySelector("nav[aria-label]");
    return [...(nav?.querySelectorAll("button") ?? [])]
      .find((b) => b.className.includes("text-primary"))
      ?.textContent?.trim();
  };
  const selectedTab = () =>
    [...document.querySelectorAll('[data-slot="tabs-trigger"]')]
      .find((el) => el.getAttribute("aria-selected") === "true")
      ?.textContent?.trim()
      .replace(/\s*\d+$/, "");

  try {
    // 模型云服务 → 云端模型（厂商面板渲染出来了）
    await routeTo("network");
    expect(activeNav()).toBe(zh("cloud.title"));
    expect(document.body.textContent ?? "").toContain(zh("cloud.desc"));
    // 默认模型：自己一页（不再挂在云端模型页里），也认这个老 id
    await routeTo("defaults");
    expect(activeNav()).toBe(zh("defaults.title"));
    expect(document.body.textContent ?? "").toContain(zh("defaults.desc"));
    expect(document.body.textContent ?? "").not.toContain(zh("cloud.desc"));
    // 本地模型 → 运行模型（引擎选择 + 空态指路模型库）
    await routeTo("model");
    expect(activeNav()).toBe(zh("run.title"));
    expect(document.body.textContent ?? "").toContain(zh("library.localEmpty"));
    // 模型库（store）→ 默认页签「本地已下载」
    await routeTo("store");
    expect(activeNav()).toBe(zh("library.title"));
    expect(selectedTab()).toBe(zh("library.tab.downloaded"));
    // 在线模型市场 → 模型库的市场页签
    await routeTo("market");
    expect(activeNav()).toBe(zh("library.title"));
    expect(selectedTab()).toBe(zh("library.tab.market"));
  } finally {
    // 复位：路由是全局 store，留着会把后面的用例按在模型库里；断言失败也要收掉 DOM，
    // 否则后面每个用例都叠着一份残留的设置页。
    await act(async () => {
      useRouter.getState().setRoute({ path: "settings", tab: "stats" });
    });
    await cleanup();
  }
});

test("点「通用」进得去代理卡：模式、本地网络开关、采样都在", async () => {
  const { cleanup } = await renderSettings();
  const nav = document.querySelector("nav[aria-label]");
  const general = [...nav!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "通用");
  expect(general).not.toBeUndefined();
  await act(async () => {
    (general as unknown as HTMLElement).click();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const text = document.body.textContent ?? "";
  expect(text).toContain(zh("settings.proxy.title"));
  expect(text).toContain(zh("settings.proxy.allowLocalNetwork"));
  expect(document.querySelectorAll('[data-slot="proxy-sample"]')).toHaveLength(4);
  await cleanup();
});

/**
 * 设置 → 外观 → 左侧一级菜单：15 条都在，顺序与显隐都能落进 `APP_RAIL_LAYOUT`。
 *
 * 拖动靠指针几何判定，而 happy-dom 里布局尺寸全是 0 —— 测不了拖动本身，所以排序这条
 * 链路走手柄上的 ↑ / ↓：它和拖动共用同一个 `moveRailEntry` + `persist`，证明了
 * 「排序 → 写库」这段是通的；指针那一层只有"落在哪一行的上半"这一个几何判断没被覆盖。
 */
test("外观里的左侧一级菜单：条目齐全，方向键排序与显示开关都写回 APP_RAIL_LAYOUT", async () => {
  const { defaultRailLayout, moveRailEntry, serializeRailLayout, toggleRailEntry, APP_RAIL_IDS } =
    await import("../../../shared/app-rail");
  const { cleanup } = await renderSettings();
  const nav = document.querySelector("nav[aria-label]");
  const appearance = [...nav!.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === "外观",
  );
  expect(appearance).not.toBeUndefined();
  await act(async () => {
    (appearance as unknown as HTMLElement).click();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const rows = () => [...document.querySelectorAll('[data-slot="rail-menu-row"]')];
  const order = () => rows().map((row) => row.getAttribute("data-app"));
  expect(order()).toEqual([...APP_RAIL_IDS]);
  expect(document.querySelectorAll('[data-slot="rail-menu-handle"]')).toHaveLength(
    APP_RAIL_IDS.length,
  );
  expect(document.querySelectorAll('[data-slot="switch"]')).toHaveLength(APP_RAIL_IDS.length);

  // 还没改过 = 默认布局，此时「恢复默认」没有意义，是禁用状态
  const reset = [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(zh("settings.appearance.menu.reset")),
  );
  expect(reset).not.toBeUndefined();
  expect(reset!.hasAttribute("disabled")).toBe(true);

  // 方向键排序：第一条往下挪一位（拖动走的是同一条 persist）
  settingsPatches.length = 0;
  const firstHandle = document.querySelector('[data-slot="rail-menu-handle"]');
  expect(firstHandle).not.toBeNull();
  await act(async () => {
    firstHandle!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const moved = moveRailEntry(defaultRailLayout(), 0, 1);
  expect(settingsPatches).toEqual([
    { APP_RAIL_LAYOUT: serializeRailLayout(moved) },
  ]);
  expect(order()).toEqual(moved.map((entry) => entry.id));

  // 显示开关：关掉第二条 → 落盘的是"当前顺序 + 这一条 hidden"
  settingsPatches.length = 0;
  const second = document.querySelectorAll('[data-slot="switch"]')[1];
  await act(async () => {
    (second as unknown as HTMLElement).click();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(settingsPatches).toEqual([
    {
      APP_RAIL_LAYOUT: serializeRailLayout(toggleRailEntry(moved, moved[1]!.id, true)),
    },
  ]);
  expect(rows()[1]!.getAttribute("data-hidden")).toBe("true");
  // 这一行的开关真的关上了（关 = 从左侧菜单里藏掉）
  expect(rows()[1]!.querySelector('[data-slot="switch"]')!.getAttribute("aria-checked")).toBe(
    "false",
  );

  await cleanup();
});

test("自启动开关落在概览页：默认开启，关掉后写入 AUTO_START_SERVER=0", async () => {
  const { text, cleanup } = await renderSettings();
  expect(text).toContain(zh("settings.autoStart"));

  const toggle = document.querySelector('[data-slot="switch"]');
  expect(toggle).not.toBeNull();
  expect(toggle!.getAttribute("aria-checked")).toBe("true"); // 未设置过 = 默认 "1"

  settingsPatches.length = 0;
  await act(async () => {
    (toggle as unknown as HTMLElement).click();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(settingsPatches).toEqual([{ AUTO_START_SERVER: "0" }]);
  await cleanup();
});

/**
 * 页面宽度只有一份。
 *
 * 每页各写自己的 `max-w-*`（曾经同时存在 max-w-2xl / 3xl / 5xl / 6xl 四种，控制台那份
 * 干脆一个都没写），切标签页时内容左右边缘会来回跳 —— 这里钉住"所有标签页都用
 * `PageShell` 的同一个宽度"：容器在场、宽度等于 `PAGE_WIDTH`、且页面没有再写第二个
 * `max-w-*` 把它盖掉。
 */
test("每个标签页的内容容器宽度一致（都走 PageShell 的单一宽度）", async () => {
  const { PAGE_WIDTH } = await import("@components/setting-ui");
  const { cleanup } = await renderSettings();
  const nav = document.querySelector("nav[aria-label]");

  // 挑的是改造前宽度各不相同的页面：概览/模型库是 3xl，使用统计 6xl，通用这类行式页面 2xl，
  // 控制台完全没有宽度上限；运行模型（原「本地模型」）与模型引擎（原「引擎」）也算。
  for (const label of ["概览", "模型库", "运行模型", "云端模型", "模型引擎", "使用统计", "通用", "控制台"]) {
    const button = [...nav!.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === label,
    );
    expect(button).not.toBeUndefined();
    await act(async () => {
      (button as unknown as HTMLElement).click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const shells = document.querySelectorAll('[data-slot="page-shell"]');
    expect({ label, shells: shells.length }).toEqual({ label, shells: 1 });
    const widths = shells[0]!.className
      .split(/\s+/)
      .filter((cls) => cls.startsWith("max-w-"));
    expect({ label, widths }).toEqual({ label, widths: [PAGE_WIDTH] });
  }

  await cleanup();
});

test("原「性能」页的参数在「模型库 → 运行模型」里都有入口（删页面不丢设置）", async () => {
  const { PARAM_FIELDS, PIPELINE_FIELDS } = await import("../local-models/params");
  const keys = new Set([
    ...Object.values(PARAM_FIELDS).flat().map((f) => f.key),
    ...PIPELINE_FIELDS.map((f) => f.key),
    // KV 缓存只留一个控件，改 K 时同时写 V（旧「性能」页是两个下拉）。
    "SERVER_CACHE_TYPE_V",
  ]);
  for (const key of [
    "SERVER_CTX_SIZE",
    "SERVER_GPU_LAYERS",
    "SERVER_PARALLEL",
    "SERVER_BATCH_SIZE",
    "SERVER_UBATCH_SIZE",
    "SERVER_CACHE_TYPE_K",
    "MAX_VLLM_RETRIES",
    "MAX_VLLM_FAILURE_RETRIES",
    "PAGE_CONCURRENCY",
  ]) {
    expect({ key, listed: keys.has(key) }).toEqual({ key, listed: true });
  }
});
