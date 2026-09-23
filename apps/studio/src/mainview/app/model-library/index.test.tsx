import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 模型库的回归测试。
 *
 * 这一页是模型本身的唯一入口，横向三个页签：**模型市场 / 本地已下载 / 我收藏的模型**
 *（运行、云端厂商、引擎安装都不在这页里，各有各的菜单）。钉住五件事：
 *   1. 页签是**横向**的（左右切换，不是竖排菜单），顺序就是上面这个顺序，默认停在「本地已下载」；
 *   2. 本机一个模型都没有时，「本地已下载」里要直说「本地还没有模型」，点它给的按钮切到「模型市场」；
 *   3. 已下载页把当前引擎跑不了的模型也列出来（带「将自动切换引擎」标记），
 *      否则切一次引擎就会有一批模型"凭空消失"；
 *   4. 收藏页只列收藏过的模型，且不按当前引擎过滤（收藏是"我关心的模型"，启动时会自动切引擎）；
 *   5. 模型市场页真的渲染检索界面（平台切换 + 搜索框 + 推荐清单）。
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

/** 已安装模型清单：一条 GGUF 收藏（llama.cpp 能跑）、一条 safetensors 收藏（vLLM 的）、
 *  一条没收藏的 GGUF。用来同时验证"收藏过滤"与"不按引擎过滤"。 */
type FakeModel = {
  path: string;
  repo: string;
  fileName: string;
  size: number;
  isActive: boolean;
  isChatModel: boolean;
  category: string;
  favorite: boolean;
  origin: string;
  isDir: boolean;
  kind: string;
  runtimeTarget: string;
};

function model(over: Partial<FakeModel> & { path: string; fileName: string }): FakeModel {
  return {
    repo: "Qwen/Qwen3-4B-GGUF",
    size: 2.5e9,
    isActive: false,
    isChatModel: true,
    category: "chat",
    favorite: false,
    origin: "managed",
    isDir: false,
    kind: "gguf",
    runtimeTarget: over.path,
    ...over,
  };
}

let installed: FakeModel[] = [];

mock.module("@lib/rpc", () => ({
  rpcClient: {
    getSettings: async () => ({ settings: {}, platform: "darwin" }),
    listInstalledModels: async () => ({ models: installed }),
    getModelDirs: async () => ({ dirs: [] }),
    listChatModels: async () => ({ models: [] }),
    listServedModels: async () => ({ models: [] }),
    listLocalEngines: async () => ({ engines: [] }),
    cloudProviderList: async () => ({ providers: [] }),
    getServerStats: async () => ({}),
    searchMarketModels: async () => ({ models: [], total: 0, totalExact: true, hasMore: false }),
    toggleFavoriteModel: async () => ({ ok: true }),
    updateSettings: async () => ({ settings: {} }),
    openPath: async () => ({ ok: true }),
  },
}));

const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("@ui/tooltip");
const { ModelLibraryScreen } = await import("./index");
const { useUILang } = await import("@stores/ui-lang");
const { translate } = await import("../../../shared/i18n");

const zh = (key: string, params?: Record<string, string>) => translate("zh", key, params);

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

/** 页签是受控的（宿主保存当前页签，设置页据此把路由跳转落到位），所以在这里配一个
 *  最小宿主：页签状态由 harness 持有，切页签走 React 的正常更新路径。 */
function LibraryHarness() {
  const [tab, setTab] = useState<"market" | "downloaded" | "favorites">("downloaded");
  return createElement(ModelLibraryScreen, { tab, onTabChange: setTab });
}

async function renderLibrary() {
  useUILang.getState().setLang("zh");
  for (const el of Array.from(document.body.children)) el.remove();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TooltipProvider, null, createElement(LibraryHarness)),
      ),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const triggers = () => [...document.querySelectorAll('[data-slot="tabs-trigger"]')];
  const clickTab = async (label: string) => {
    const trigger = triggers().find((el) => el.textContent?.trim().startsWith(label));
    expect(trigger).toBeDefined();
    // 页签切换：Appica（Base UI）的触发是 click，Radix 时代是 mousedown。
    // 两个都发，适配器换回哪一边测试都照样切页签（只发一个会"绿着"停在默认页签上）。
    await act(async () => {
      const el = trigger as HTMLElement;
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      el.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  return {
    get text() {
      return document.body.textContent ?? "";
    },
    triggers,
    clickTab,
    /** 点页签内容里的第一颗带这个文案的按钮（空态的"去模型市场下载"）。 */
    clickButton: async (label: string) => {
      const button = [...document.querySelectorAll("button")].find((b) =>
        b.textContent?.trim().startsWith(label),
      );
      expect(button).toBeDefined();
      await act(async () => {
        (button as HTMLElement).click();
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
    selectedTab: () =>
      triggers()
        .find((el) => el.getAttribute("aria-selected") === "true")
        ?.textContent?.trim()
        .replace(/\s*\d+$/, ""),
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

test("页签是横向的一行，顺序为 模型市场 → 本地已下载 → 我收藏的模型，默认停在本地已下载", async () => {
  installed = [];
  const view = await renderLibrary();
  const tabs = view.triggers();
  expect(tabs.map((el) => el.textContent?.trim().replace(/\s*\d+$/, ""))).toEqual([
    zh("library.tab.market"),
    zh("library.tab.downloaded"),
    zh("library.tab.favorites"),
  ]);
  // 左右切换（horizontal）：竖排 Tabs 会渲染成 data-orientation="vertical"
  const list = document.querySelector('[data-slot="tabs-list"]');
  expect(list?.closest('[data-slot="tabs"]')?.getAttribute("data-orientation")).toBe("horizontal");
  expect(view.selectedTab()).toBe(zh("library.tab.downloaded"));
  await view.unmount();
});

test("本地没有模型时直说「本地还没有模型」，按钮切到模型市场页签", async () => {
  installed = [];
  const view = await renderLibrary();
  expect(view.text).toContain(zh("library.localEmpty"));
  expect(view.text).not.toContain(zh("models.recommended"));

  await view.clickButton(zh("library.goMarket"));
  expect(view.selectedTab()).toBe(zh("library.tab.market"));
  // 市场就在隔壁页签里（平台切换 + 推荐清单），不是把人丢到别的页面
  expect(view.text).toContain(zh("market.sourceLabel"));
  expect(view.text).toContain(zh("models.recommended"));
  await view.unmount();
});

test("本地已下载页把当前引擎跑不了的模型也列出来（带「将自动切换引擎」标记）", async () => {
  installed = [
    model({ path: "/m/qwen3-4b.gguf", fileName: "qwen3-4b.gguf" }),
    model({
      path: "/m/deepseek-r1",
      repo: "deepseek-ai/DeepSeek-R1",
      fileName: "DeepSeek-R1",
      kind: "safetensors",
      isDir: true,
    }),
  ];
  const view = await renderLibrary();
  // 默认引擎是 llama.cpp：GGUF 能直接跑，safetensors 那份照样列出来，
  // 否则切一次引擎就会有一批模型"凭空消失"。
  expect(view.text).toContain("qwen3-4b.gguf");
  expect(view.text).toContain("DeepSeek-R1");
  expect(view.text).toContain(zh("models.autoSwitchEngine"));
  await view.unmount();
});

test("模型市场页签渲染检索界面：平台切换 + 搜索 + 推荐清单", async () => {
  installed = [];
  const view = await renderLibrary();
  await view.clickTab(zh("library.tab.market"));
  expect(view.text).toContain(zh("market.sourceLabel"));
  expect(view.text).toContain("ModelScope");
  expect(view.text).toContain(zh("market.formatLabel"));
  expect(view.text).toContain(zh("models.recommended"));
  // 搜索框在场（placeholder 里带平台名）
  const input = [...document.querySelectorAll("input")].find((el) =>
    (el.getAttribute("placeholder") ?? "").includes("ModelScope"),
  );
  expect(input).not.toBeUndefined();
  await view.unmount();
});

test("我收藏的模型：只列收藏的，且不按当前引擎过滤", async () => {
  installed = [
    model({ path: "/m/qwen3-4b.gguf", fileName: "qwen3-4b.gguf", favorite: true }),
    model({
      path: "/m/deepseek-r1",
      repo: "deepseek-ai/DeepSeek-R1",
      fileName: "DeepSeek-R1",
      kind: "safetensors",
      isDir: true,
      favorite: true,
    }),
    model({ path: "/m/qwen3-8b.gguf", fileName: "qwen3-8b.gguf", favorite: false }),
  ];
  const view = await renderLibrary();
  await view.clickTab(zh("library.tab.favorites"));

  expect(view.text).toContain("qwen3-4b.gguf");
  // 收藏里的 safetensors（当前引擎 llama.cpp 跑不了）照样列出来 —— 启动时会自动切引擎
  expect(view.text).toContain("DeepSeek-R1");
  // 没收藏的不出现
  expect(view.text).not.toContain("qwen3-8b.gguf");
  // 收藏页不摆"来源筛选"那一行（跨来源的一份清单，按来源再切一次是噪音）。
  // 行上的来源标是 span，筛选是带计数的 button —— 按 button 认；"全部"那颗两行都有，
  // 拿来源名去认，别把下面那排分类药丸算进来。
  const chipLabels = [
    zh("models.origin.managed"),
    zh("models.origin.external"),
    zh("models.origin.hfCache"),
  ];
  const originChips = [...document.querySelectorAll("button")].filter((b) =>
    chipLabels.some((label) => (b.textContent ?? "").startsWith(label)),
  );
  expect(originChips).toHaveLength(0);
  await view.unmount();
});

test("没有收藏时给专门的空态文案（不是「本地还没有模型」）", async () => {
  installed = [model({ path: "/m/qwen3-4b.gguf", fileName: "qwen3-4b.gguf" })];
  const view = await renderLibrary();
  await view.clickTab(zh("library.tab.favorites"));
  expect(view.text).toContain(zh("library.favoritesEmpty"));
  expect(view.text).not.toContain(zh("library.localEmpty"));
  await view.unmount();
});
