import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 控制台日志区的回归测试。
 *
 * 在此之前应用日志在界面里**完全看不到**（只能 `omi logs` / 翻文件系统），
 * 这里锁住三件容易悄悄退化的事：
 *   1. 默认就是应用日志，条目按「时间 / 级别 / 来源 / 事件 / 消息」成表，detail 点开能看；
 *   2. 级别与「最近 N 条」真的发到了主进程（日志大时不能靠前端全量过滤）；
 *   3. 来源切换器能在应用日志与每个实例的实时输出之间切，且模型输出按行数裁。
 *
 * happy-dom 提供真实 DOM（Radix 的 Select / Tooltip 需要），afterAll 还原全局。
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
  "HTMLTableRowElement",
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

type LogLevel = "debug" | "info" | "warn" | "error";
const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 150 条：info 132 / debug 12 / warn 3 / error 3 —— 级别过滤的效果一眼可数。 */
const APP_LOG = Array.from({ length: 150 }, (_, i) => ({
  seq: i + 1,
  ts: 1_700_000_000_000 + i * 1000,
  level: (i % 50 === 0 ? "error" : i % 25 === 0 ? "warn" : i % 10 === 0 ? "debug" : "info") as LogLevel,
  source: "app",
  event: `app.event.${i}`,
  message: `消息 ${i}`,
  pid: 777,
  detail: i === 149 ? { backend: "api" } : undefined,
}));

const SERVED_LOG = Array.from({ length: 150 }, (_, i) => `line ${i}`).join("\n");

const SERVED_MODEL = {
  id: "m1",
  modelRef: "Qwen/Qwen3-8B-GGUF",
  label: "Qwen3-8B",
  engine: "llama.cpp" as const,
  port: 8080,
  endpoint: "http://127.0.0.1:8080/v1",
  servedName: "qwen3-8b",
  status: "running" as const,
  usesDefaultPort: true,
  isActive: true,
  isDir: false,
};

/** 每次 getAppLogs 的入参：断言「过滤在下发前就交给主进程了」。 */
const appLogCalls: Record<string, unknown>[] = [];

type Query = Record<string, unknown> | undefined;

mock.module("@lib/rpc", () => ({
  rpcClient: {
    // 模仿主进程的语义：level 是「该级别及以上」，limit 取**最新**的 N 条。
    getAppLogs: async (params: Query) => {
      appLogCalls.push(params ?? {});
      const level = params?.level as LogLevel | undefined;
      const limit = Number(params?.limit ?? 100);
      const since = params?.since == null ? undefined : Number(params.since);
      let hits = APP_LOG.filter(
        (entry) =>
          (!level || RANK[entry.level] >= RANK[level]) && (since == null || entry.ts >= since),
      );
      hits = hits.slice(-limit);
      if (params?.oldestFirst !== true) hits = [...hits].reverse();
      return { entries: hits, path: "/tmp/omni/logs/app.log" };
    },
    getAppLogInfo: async () => ({
      dir: "/tmp/omni/logs",
      path: "/tmp/omni/logs/app.log",
      memoryEntries: 12,
      files: [
        { path: "/tmp/omni/logs/app.log", size: 2048, rotated: false },
        { path: "/tmp/omni/logs/app-2026-01-02T03-04-05-000Z.log", size: 4096, rotated: true },
      ],
    }),
    clearAppLogs: async () => ({ ok: true, cleared: 3 }),
    listServedModels: async () => ({ models: [SERVED_MODEL], activeId: SERVED_MODEL.id }),
    getServedModelLogs: async () => ({ logs: SERVED_LOG }),
    clearServedModelLogs: async () => ({ ok: true }),
    listInstalledModels: async () => ({ models: [] }),
  },
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("@ui/tooltip");
const { ConsoleScreen } = await import("./console-screen");
const { translate } = await import("../../../shared/i18n");

const zh = (key: string) => translate("zh", key);

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

async function renderConsole() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TooltipProvider, null, createElement(ConsoleScreen)),
      ),
    );
  });
  // 一拍给查询解析，一拍给渲染（日志行 + 已启动模型两条数据线）。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  /** 按可见文字点一个按钮（chip / 工具栏按钮都是 button）。 */
  const click = async (label: string, startsWith = false) => {
    const button = [...container.querySelectorAll("button")].find((b) => {
      const text = b.textContent?.trim() ?? "";
      return startsWith ? text.startsWith(label) : text === label;
    });
    if (!button) throw new Error(`找不到按钮「${label}」`);
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await settle();
  };
  const tableRows = () => [...container.querySelectorAll('[data-slot="app-log-table"] tbody tr')];

  return {
    container,
    text: () => container.textContent ?? "",
    tableRows,
    click,
    settle,
    hasAppLogTable: () => container.querySelector('[data-slot="app-log-table"]') !== null,
    waitFor: async (ms: number) => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      });
    },
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

test("默认看应用日志：条目成表（含级别 / 来源 / 事件），detail 点开能看", async () => {
  appLogCalls.length = 0;
  const view = await renderConsole();

  // 来源切换器在：应用日志 + 一个已启动实例。
  expect(view.text()).toContain(zh("console.appLog"));
  expect(view.text()).toContain("Qwen3-8B");
  expect(view.hasAppLogTable()).toBe(true);

  const first = appLogCalls[0]!;
  expect(first.limit).toBe(100);
  expect(first.level).toBeUndefined();
  expect(first.oldestFirst).toBe(true);

  const row = view.tableRows().find((tr) => tr.textContent?.includes("消息 149"));
  expect(row).not.toBeUndefined();
  expect(row!.textContent).toContain(zh("console.level.info")); // 级别 chip
  expect(row!.textContent).toContain("app.event.149"); // 事件名
  expect(view.text()).not.toContain('"backend": "api"');

  await act(async () => {
    row!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  expect(view.text()).toContain('"backend": "api"');

  await view.cleanup();
});

test("级别筛选下发给主进程：选「警告」只剩 warn + error", async () => {
  appLogCalls.length = 0;
  const view = await renderConsole();
  expect(view.text()).toContain(translate("zh", "console.entriesCount", { n: "100" }));

  await view.click(zh("console.level.warn"));

  const last = appLogCalls[appLogCalls.length - 1]!;
  expect(last.level).toBe("warn");
  // 3 条 warn + 3 条 error；info 的那批（消息 149）不再出现在表里。
  expect(view.text()).toContain(translate("zh", "console.entriesCount", { n: "6" }));
  expect(view.text()).not.toContain("消息 149");
  expect(view.text()).toContain("消息 125");

  // 切回「全部」：又回到 100 条窗口
  await view.click(zh("common.all"));
  expect(appLogCalls[appLogCalls.length - 1]!.level).toBeUndefined();
  expect(view.text()).toContain("消息 149");

  await view.cleanup();
});

test("最近 N 条：换档位真的改 limit（100 → 2000）", async () => {
  appLogCalls.length = 0;
  const view = await renderConsole();
  expect(view.text()).toContain(translate("zh", "console.entriesCount", { n: "100" }));

  await view.click("2000");

  expect(appLogCalls[appLogCalls.length - 1]!.limit).toBe(2000);
  expect(view.text()).toContain(translate("zh", "console.entriesCount", { n: "150" }));

  await view.click("500");
  expect(appLogCalls[appLogCalls.length - 1]!.limit).toBe(500);

  await view.cleanup();
});

test("来源切换：切到实例实时输出按行裁，切回应用日志回到表格", async () => {
  const view = await renderConsole();

  await view.click("Qwen3-8B", true);

  // 终端接管日志区（应用日志的表格消失），模型输出只留最近 100 行。
  expect(view.hasAppLogTable()).toBe(false);
  expect(view.text()).toContain("line 149");
  expect(view.text()).toContain("line 50");
  expect(view.text()).not.toContain("line 49");
  // 跟随最新只对实时文件有意义，模型输出这边不给这个按钮。
  expect(view.text()).not.toContain(zh("console.following"));

  await view.click(zh("console.appLog"));
  expect(view.hasAppLogTable()).toBe(true);

  await view.cleanup();
});

test("跟随最新：首屏拉全量，之后每秒只取新记录（memoryOnly + since）", async () => {
  appLogCalls.length = 0;
  const view = await renderConsole();

  expect(appLogCalls[0]!.memoryOnly).toBeUndefined();
  expect(appLogCalls[0]!.since).toBeUndefined();

  await view.waitFor(1200);

  const polls = appLogCalls.slice(1);
  expect(polls.length).toBeGreaterThan(0);
  for (const poll of polls) {
    // 落到磁盘的轮询会每秒整份读日志文件；memoryOnly + since 是「便宜轮询」的全部要求。
    expect(poll.memoryOnly).toBe(true);
    expect(typeof poll.since).toBe("number");
  }

  await view.cleanup();
});
