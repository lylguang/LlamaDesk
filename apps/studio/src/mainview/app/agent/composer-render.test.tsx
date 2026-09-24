import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 输入区对消息数组的订阅：模型流式输出时，activeMessages 每来一个增量就换一份，
 * 输入区不该跟着重渲染（它不显示消息内容）；发送时改用 getState() 现取，
 * 追加目标仍然是当时最新的数组。
 *
 * 脚手架（happy-dom 全局注入 / rpc mock / 清理）照抄 composer-slash.test.tsx；
 * 重渲染计数用 React 的 Profiler（任务要求的原样计数：onRender 每次子树重
 * 渲染调一次）。断言看的是 18 次流式增量期间（每 3 个后回空 + settle）的
 * 净增长：订阅还在时每次调用必然 +1（19+）；订阅删掉后增量期间稳定，净增
 * ≤ 7（残余是 messageStats 换引用的固有抖动，实测落在回空那一步、每轮 ≤ 1
 * 次），阈值 7 区分度清晰。多次回空是为了防「只数第一次」的假阳性。
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
  "HTMLTextAreaElement",
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

const CONVERSATION_ID = 7;
const calls: { method: string; params: unknown }[] = [];

mock.module("@lib/rpc", () => {
  const handler: ProxyHandler<Record<string, unknown>> = {
    get: (_target, prop: string) => async (params: unknown) => {
      calls.push({ method: prop, params });
      if (prop === "getSettings") return { settings: {} };
      if (prop === "getAgentWorkspace") return { workspace: "/tmp/ws" };
      if (prop === "getConversation") {
        return { conversation: { id: CONVERSATION_ID, title: "t", app: "agent" }, messages: [] };
      }
      if (prop === "sendAgentMessage") return { ok: true };
      if (prop === "listChatModels") return { models: [] };
      if (prop === "listWorkspaceFiles") return { nodes: [] };
      if (prop === "getAgentPermissions") return { mode: "auto" };
      return {};
    },
  };
  return { rpcClient: new Proxy({}, handler) };
});

const { act, createElement, Profiler } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { AgentComposer } = await import("./composer");
const { useAgentStore } = await import("@stores/agent");
const { useChatStore } = await import("@stores/chat");

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

afterEach(() => {
  for (const el of Array.from(document.body.children)) el.remove();
  calls.length = 0;
});

/** 写值必须走原生 setter，否则 React 的 value tracker 看不见这次输入。 */
async function type(input: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function clickSend(container: HTMLElement) {
  const sendBtn = container.querySelector<HTMLButtonElement>("button.send-btn");
  if (!sendBtn) throw new Error("发送按钮没渲染出来");
  await act(async () => {
    sendBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const sleep = () => new Promise((resolve) => setTimeout(resolve, 0));

async function mount() {
  useChatStore.getState().setActiveConversation(CONVERSATION_ID);
  useChatStore.getState().setActiveMessages([]);
  useChatStore.getState().setStreaming(false);
  useAgentStore.getState().setMode("agent");
  useAgentStore.getState().setRunning(false);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const renders = { count: 0 };
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          Profiler,
          { id: "composer", onRender: () => { renders.count += 1; } },
          createElement(AgentComposer, { conversationId: CONVERSATION_ID, mode: "agent" }),
        ),
      ),
    );
  });
  // 把挂载后晚到的更新（查询 resolve、ResizeObserver）引出来，稳定后再取基线。
  for (let i = 0; i < 6; i += 1) await act(async () => await sleep());
  await act(async () => {
    useChatStore.getState().setActiveMessages([]);
  });
  for (let i = 0; i < 8; i += 1) await act(async () => await sleep());

  const input = container.querySelector<HTMLTextAreaElement>("textarea.composer-input");
  if (!input) throw new Error("输入框没渲染出来");
  return {
    container,
    input,
    renders,
    unmount: async () => act(async () => root.unmount()),
  };
}

test("流式增量不再让输入区重渲染", async () => {
  const { container, renders, unmount } = await mount();
  const before = renders.count;
  const stream = (i: number) =>
    act(async () => {
      // 模拟流式输出：每来一个增量，最后一条消息的 content 变、数组整体换新。
      useChatStore
        .getState()
        .setActiveMessages([
          { id: 1, conversationId: CONVERSATION_ID, role: "user", content: "你好", createdAt: 1 },
          {
            id: 2,
            conversationId: CONVERSATION_ID,
            role: "assistant",
            content: "流式输出中…".repeat(i),
            createdAt: 2,
          },
        ]);
    });
  const reset = () =>
    act(async () => {
      useChatStore.getState().setActiveMessages([]);
    });
  // 18 次流式增量，每 3 个后回空并 settle。
  // 断言口径：18 次流式增量期间，renders.count 的净增**等于 0**；
  // 回空（setActiveMessages([])）那几次允许 +1，因为那次是真的有键被过滤掉、
  // messageStats 本来就该换引用。
  let incTotal = 0;
  let resetTotal = 0;
  let prev = before;
  const step = () => {
    const d = renders.count - prev;
    prev = renders.count;
    return d;
  };
  for (let i = 1; i <= 18; i += 1) {
    await stream(i);
    const incDelta = step();
    incTotal += incDelta;
    // 增量期间：净增必须等于 0（订阅已删、messageStats 不再无谓换引用）。
    expect(incDelta).toBe(0);
    if (i % 3 === 0) {
      await reset();
      const resetDelta = step();
      resetTotal += resetDelta;
      // 回空那一步：真的有键被过滤掉，允许 +1。
      expect(resetDelta).toBeGreaterThanOrEqual(0);
      expect(resetDelta).toBeLessThanOrEqual(1);
      for (let t = 0; t < 8; t += 1) await act(async () => await sleep());
      step(); // settle 后的残余（如果有）单独记账
    }
  }
  await reset();
  const finalResetDelta = step();
  resetTotal += finalResetDelta;
  expect(finalResetDelta).toBeGreaterThanOrEqual(0);
  expect(finalResetDelta).toBeLessThanOrEqual(1);
  // 汇总：18 次流式增量期间的净增必须等于 0。
  expect(incTotal).toBe(0);
  // 7 次回空（含最后一次），每次允许 +1，总计 ≤ 7。
  expect(resetTotal).toBeGreaterThanOrEqual(0);
  expect(resetTotal).toBeLessThanOrEqual(7);
  expect(useChatStore.getState().activeMessages).toEqual([]);
  await unmount();
  void container;
});

test("发送时把新消息追加到当时最新的数组上", async () => {
  const { container, input, unmount } = await mount();
  useChatStore
    .getState()
    .setActiveMessages([
      { id: 1, conversationId: CONVERSATION_ID, role: "user", content: "第一条", createdAt: 1 },
      { id: 2, conversationId: CONVERSATION_ID, role: "assistant", content: "第二条", createdAt: 2 },
    ]);
  await type(input, "第三");
  await clickSend(container);

  const messages = useChatStore.getState().activeMessages;
  expect(messages).toHaveLength(3);
  expect(messages[2]).toMatchObject({ role: "user", content: "第三" });
  expect(
    calls.some(
      (call) => call.method === "sendAgentMessage" && (call.params as { content?: string }).content === "第三",
    ),
  ).toBe(true);
  await unmount();
});
