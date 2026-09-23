import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 左侧一级菜单（应用栏）渲染的回归测试。
 *
 * 菜单条目的顺序与显隐现在由设置 `APP_RAIL_LAYOUT` 驱动（设置 → 外观 → 左侧一级菜单）。
 * 这里钉住两件事：**默认布局**是全部条目、默认顺序；**存了的布局**被真的照做 ——
 * 顺序按存的来、被隐藏的不出现。解析规则本身在 shared/app-rail.test.ts 里逐条钉过，
 * 这里只管"菜单有没有照着渲染"。
 *
 * happy-dom 提供真实 DOM（Radix 的 Tooltip 需要），afterAll 还原全局。
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

/** 每个用例自己摆一份设置，模拟"用户已经配过一遍"。 */
let storedSettings: Record<string, string> = {};

mock.module("@lib/rpc", () => ({
  rpcClient: {
    getSettings: async () => ({ settings: storedSettings }),
  },
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("@ui/tooltip");
const { AppRail } = await import("./app-rail");
const { translate } = await import("../../../shared/i18n");
const { APP_RAIL_IDS, APP_RAIL_LAYOUT_KEY } = await import("../../../shared/app-rail");
const { useRouter } = await import("@stores/router");

const zh = (key: string) => translate("zh", key);

beforeEach(() => {
  storedSettings = {};
});

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

/** 渲染菜单并返回每条的 tooltip 文案（= 条目名，按菜单自上而下的顺序）。 */
async function renderRail() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TooltipProvider, null, createElement(AppRail)),
      ),
    );
  });
  // 一拍给查询解析，一拍给渲染。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const labels = [...document.querySelectorAll('nav[aria-label="App rail"] button')].map(
    (button) => button.getAttribute("aria-label"),
  );
  return {
    labels,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

test("没配过（设置里是空串）时就是默认那 15 条，顺序与默认一致，底部是设置入口", async () => {
  const { labels, cleanup } = await renderRail();
  expect(labels).toEqual([
    ...APP_RAIL_IDS.map((id) => zh(`apps.${id}`)),
    zh("nav.settings"),
  ]);
  await cleanup();
});

test("存过的布局照做：顺序按存的来，隐藏的条目不出现在菜单里", async () => {
  storedSettings = {
    [APP_RAIL_LAYOUT_KEY]: JSON.stringify([
      { id: "music" },
      { id: "kb" },
      { id: "chat", hidden: true },
      { id: "agent", hidden: true },
    ]),
  };
  const { labels, cleanup } = await renderRail();

  // 前两位是配过的顺序，其余按默认顺序补在后面（没提到的条目不会被丢掉）
  expect(labels.slice(0, 2)).toEqual([zh("apps.music"), zh("apps.kb")]);
  expect(labels).toHaveLength(APP_RAIL_IDS.length - 2 + 1); // 减去藏掉的两条，加上设置入口
  expect(labels).not.toContain(zh("apps.chat"));
  expect(labels).not.toContain(zh("apps.agent"));
  // 设置入口永远在最后，不参与排序，也不能被藏掉
  expect(labels[labels.length - 1]).toBe(zh("nav.settings"));
  await cleanup();
});

test("坏配置不会把菜单清空：认不出的 id 丢掉，其余照常显示", async () => {
  storedSettings = { [APP_RAIL_LAYOUT_KEY]: '[{"id":"nope"},{"id":"music"}]' };
  const { labels, cleanup } = await renderRail();
  expect(labels[0]).toBe(zh("apps.music"));
  expect(labels).toHaveLength(APP_RAIL_IDS.length + 1);
  await cleanup();
});

/** 菜单条目点一下就切应用 + 回主路由 —— 顺序改了以后这条链路不能断。 */
test("点配置里靠后的条目仍能切到对应应用", async () => {
  storedSettings = {
    [APP_RAIL_LAYOUT_KEY]: JSON.stringify([{ id: "memory" }, { id: "chat" }]),
  };
  const { labels, cleanup } = await renderRail();
  const nav = document.querySelector('nav[aria-label="App rail"]');
  const target = [...nav!.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === zh("apps.memory"),
  );
  await act(async () => {
    (target as unknown as HTMLElement).click();
  });
  const { useAppStore } = await import("@stores/app");
  expect(useAppStore.getState().activeApp).toBe("memory");
  expect(useRouter.getState().route.path).toBe("index");
  expect(labels[0]).toBe(zh("apps.memory"));
  await cleanup();
});
