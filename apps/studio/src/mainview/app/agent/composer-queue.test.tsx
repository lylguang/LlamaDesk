import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 「排队发送」按钮的可用性。
 *
 * 已发生的缺陷（用户报「运行中点发送按钮没有任何反应」）：
 *   canSend 要求 !busy，而运行中输入框有字时渲染的正是发送按钮（带排队图标、
 *   排队文案、handleSend("queue") 的点击处理）—— disabled={!canSend} 使这个
 *   按钮恒为禁用，只有不知道「要按回车」的用户被卡住。
 *
 * 这里钉住期望语义：运行中按钮可点、点击走排队（followUpAgentMessage,
 * mode: "queue"）；运行中且输入框为空仍是停止按钮；空输入时按钮禁用。
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
      if (prop === "followUpAgentMessage") return { ok: true, queued: true };
      if (prop === "listChatModels") return { models: [] };
      if (prop === "listWorkspaceFiles") return { nodes: [] };
      if (prop === "getAgentPermissions") return { mode: "auto" };
      return {};
    },
  };
  return { rpcClient: new Proxy({}, handler) };
});

const { act, createElement } = await import("react");
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
  useAgentStore.getState().setRunning(false);
});

async function setRunning(running: boolean) {
  await act(async () => {
    useAgentStore.getState().setRunning(running);
  });
}

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

async function mount() {
  useChatStore.getState().setActiveConversation(CONVERSATION_ID);
  useChatStore.getState().setActiveMessages([]);
  useChatStore.getState().setStreaming(false);
  await act(async () => {
    useAgentStore.getState().setMode("agent");
    useAgentStore.getState().setRunning(false);
  });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(AgentComposer, { conversationId: CONVERSATION_ID, mode: "agent" }),
      ),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const input = container.querySelector<HTMLTextAreaElement>("textarea.composer-input");
  if (!input) throw new Error("输入框没渲染出来");
  return {
    container,
    input,
    unmount: async () => act(async () => root.unmount()),
  };
}

const followUps = () =>
  calls
    .filter((call) => call.method === "followUpAgentMessage")
    .map((call) => call.params as { mode?: string; content?: string; conversationId?: number });

test("运行中输入文字后，发送按钮不是 disabled（本次修的缺陷）", async () => {
  const { container, input, unmount } = await mount();
  await setRunning(true);
  await type(input, "帮我看看这个报错");
  const sendBtn = container.querySelector<HTMLButtonElement>("button.send-btn");
  expect(sendBtn).not.toBeNull();
  expect(sendBtn!.disabled).toBe(false);
  await unmount();
});

test("运行中点发送按钮：发出排队请求（followUpAgentMessage, mode=queue）", async () => {
  const { container, input, unmount } = await mount();
  await setRunning(true);
  await type(input, "帮我看看这个报错");
  await clickSend(container);
  expect(followUps()).toEqual([{ mode: "queue", content: "帮我看看这个报错", conversationId: CONVERSATION_ID }]);
  expect(calls.filter((call) => call.method === "sendAgentMessage")).toEqual([]);
  await unmount();
});

test("运行中且输入框为空：显示停止按钮而不是发送按钮", async () => {
  const { container, unmount } = await mount();
  await setRunning(true);
  expect(container.querySelector("button.stop-btn")).not.toBeNull();
  expect(container.querySelector("button.send-btn")).toBeNull();
  await unmount();
});

test("不在运行且输入框为空：发送按钮仍然 disabled", async () => {
  const { container, unmount } = await mount();
  const sendBtn = container.querySelector<HTMLButtonElement>("button.send-btn");
  expect(sendBtn).not.toBeNull();
  expect(sendBtn!.disabled).toBe(true);
  await unmount();
});
