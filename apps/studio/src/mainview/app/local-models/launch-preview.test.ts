import { afterAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 自动启动参数面板的纯逻辑测试（界面渲染见 e2e，这里只测「翻译与格式化」）：
 *   1. `reasonText` 对全部 16 个 `PlanReasonCode` 在 zh / en 下都返回非空、且不等于
 *      key 原文的文案（key 原文 = 词条缺失时 `translate` 的回落值，这里用它兜住漏写）；
 *   2. `formatGiB` 的边界（0 / 不足 1 GiB / 很大的值 / 非有限数）。
 *
 * `launch-preview.tsx` 本身 import 了 `@lib/rpc`（→ electrobun，模块顶层读 `window`
 * 和 `__electrobunWebviewId` / `__electrobunRpcSocketPort`）。Bun 对 static import
 * 的加载时机不可控（有时在 DOM 设置之前执行），所以这里统一用 `await import()`：
 * 先在 globalThis 上装 happy-dom 与 electrobun 要求的两个属性，再动态 import，
 * 确保 electrobun 模块初始化时 window 一定已存在。
 */
const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.navigator,
  location: dom.location,
  history: dom.history,
  localStorage: dom.window.localStorage,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  CustomEvent: dom.window.CustomEvent,
  Event: dom.window.Event,
});
// electrobun/view 模块顶层要读的两个属性（缺失时 WebSocket URL 变成
// `ws://localhost:undefined`，直接 SyntaxError）
(dom.window as any).__electrobun = {};
(dom.window as any).__electrobunWebviewId = "test-webview";
(dom.window as any).__electrobunRpcSocketPort = 9999;

const { formatGiB, reasonText } = await import("./launch-preview");
const { translate } = await import("@/shared/i18n");
import type { TFn } from "./launch-preview";
import type { PlanReasonCode } from "@/shared/launch-planner";

afterAll(() => {
  // 收尾：还原 globalThis 上的 DOM 全局，避免污染同一 worker 里后续的纯逻辑测试
  for (const key of [
    "window",
    "document",
    "navigator",
    "location",
    "history",
    "localStorage",
    "HTMLElement",
    "Element",
    "Node",
    "CustomEvent",
    "Event",
  ] as const) {
    delete (globalThis as unknown as Record<string, unknown>)[key];
  }
});

/** 模拟 `useT()` 的翻译函数：直接调 `translate`，lang 固定。 */
function makeT(lang: "zh" | "en"): TFn {
  return (key, params) => translate(lang, key, params);
}

const ALL_CODES: PlanReasonCode[] = [
  "ctx.user",
  "ctx.native",
  "ctx.reduced",
  "ctx.floor",
  "ctx.no-metadata",
  "budget.vram",
  "budget.unified",
  "budget.system",
  "budget.overflow-to-system",
  "fa.forced-on",
  "fa.budget-conservative",
  "kv.unified",
  "kv.split-per-slot",
  "batch.raised",
  "gpu.partial-offload",
  "gpu.none",
];

describe("reasonText（16 个 code，zh / en 各一遍）", () => {
  for (const code of ALL_CODES) {
    for (const lang of ["zh", "en"] as const) {
      test(`${code} @ ${lang} 返回非空且不等于 key`, () => {
        const t = makeT(lang);
        const text = reasonText(t, { code });
        expect(text).not.toBe("");
        expect(text).not.toEqual(code);
        // 不出现未翻译的 i18n key（`models.plan.reason.*`）
        expect(text).not.toContain("models.plan.reason.");
      });
    }
  }

  test("返回的文案与字典里该 code 的词条一致（不是兜底 key）", () => {
    const t = makeT("zh");
    const text = reasonText(t, { code: "budget.overflow-to-system" });
    expect(text).toBe(translate("zh", "models.plan.reason.budgetOverflowToSystem"));
  });
});

describe("formatGiB（边界）", () => {
  test("0 → \"0.0\"", () => {
    expect(formatGiB(0)).toBe("0.0");
  });

  test("不足 1 GiB 保留一位小数", () => {
    expect(formatGiB(512 * 1024 * 1024)).toBe("0.5");
    expect(formatGiB(1024 * 1024 * 1024 - 1)).toBe("1.0");
  });

  test("1 GiB / 2.5 GiB / 10 GiB", () => {
    expect(formatGiB(1024 ** 3)).toBe("1.0");
    expect(formatGiB(2.5 * 1024 ** 3)).toBe("2.5");
    expect(formatGiB(10 * 1024 ** 3)).toBe("10.0");
  });

  test("很大的值（1 TiB）不溢出", () => {
    expect(formatGiB(1024 ** 4)).toBe("1024.0");
  });

  test("非有限数 → \"0.0\"（不渲染 NaN / Infinity）", () => {
    expect(formatGiB(Number.NaN)).toBe("0.0");
    expect(formatGiB(Number.POSITIVE_INFINITY)).toBe("0.0");
  });
});
