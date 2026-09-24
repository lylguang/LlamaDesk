import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 打开会话时轨迹事件被拉取的次数。
 *
 * 已发生的问题（本次要修的缺陷）：首次打开会话时「事件追平」的 effect 不等首次全量
 * 查询落地就开始跑 —— 那一刻 store 里还没有事件，`afterId` 算出来是 0，于是追平发出的
 * 请求等于**又一次全量拉取**。几千条轨迹的会话被完整拉两遍。
 *
 * 这里钉住两条：
 *   1. 不带 `afterId`（或 `afterId = 0`）的全量请求只发生一次（修之前是两次）；
 *   2. 首次全量落地之后追平仍然会发生（带 `afterId` 的增量请求照常发出）——
 *      防止修过头把追平整个关掉。
 */

// happy-dom 的全局注入（照抄 composer-slash.test.tsx）：渲染这条会话会用到真实的
// 定时器与 DOM 查询，afterAll 里还原全局。
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

/** listAgentEvents mock 的全量返回（不带 afterId 时）；默认空，测试可按需填。
 *  Proxy 闭包引用这个可变变量，所以测试里重新赋值就能改变全量返回的内容。 */
let eventFullReturn: AgentEventRow[] = [];

/** 置 true 时，全量（不带 afterId）的 listAgentEvents 调用会永远挂起（永不 resolve）。
 *  用来在测试里精确卡住“首次全量查询还在飞”的状态，避免依赖 microtask 时序。 */
let fullQueryPending = false;

type AgentEventRow = import("../../../bun/agent").AgentEventRow;

/** 造一条事件（供“首次全量返回真实事件”的用例使用）。 */
function event(id: number): AgentEventRow {
  return {
    id,
    conversationId: CONVERSATION_ID,
    messageId: null,
    kind: "status",
    toolName: null,
    args: "",
    output: "",
    isError: 0,
    subagentId: null,
    createdAt: Date.now(),
  };
}

// 记录每次 RPC 调用的 Proxy（照抄 composer-slash.test.tsx）：返回的都是最简空结构，
// 够组件渲染即可 —— 本测试只关心 listAgentEvents 被调了几次、带不带 afterId。
mock.module("@lib/rpc", () => {
  const handler: ProxyHandler<Record<string, unknown>> = {
    get: (_target, prop: string) => async (params: unknown) => {
      calls.push({ method: prop, params });
      if (prop === "getSettings") return { settings: {} };
      if (prop === "getAgentWorkspace") return { workspace: "/tmp/ws" };
      if (prop === "getConversation") {
        return {
          conversation: { id: CONVERSATION_ID, title: "t", app: "agent", workspace: null, modelId: null },
          messages: [],
        };
      }
      if (prop === "getAgentRunState") return { running: false, since: null };
      if (prop === "listAgentEvents") {
        // 全量（不带 afterId）：fullQueryPending 为 true 时永远挂起（模拟“还在飞”）；
        // 否则返回 eventFullReturn（默认空，测试可按需填真实事件）。
        // 带 afterId 的增量返回空（库里没有更新的）。
        const { afterId } = (params ?? {}) as { afterId?: number };
        if (afterId == null) {
          if (fullQueryPending) {
            return new Promise(() => {}); // 永不 resolve
          }
          return { events: eventFullReturn };
        }
        return { events: [] };
      }
      if (prop === "listAgentInteractions") return { permissions: [], questions: [] };
      if (prop === "listAgentTodos") return { todos: [] };
      if (prop === "listAgentArtifacts") return { artifacts: [] };
      if (prop === "getAgentGoal") return { goal: null };
      if (prop === "getAgentPlan") return { plan: null, approved: false };
      if (prop === "listAgentSnapshots") {
        return {
          enabled: false,
          gitAvailable: false,
          workspace: "",
          turns: 0,
          snapshots: [],
          usage: { repoBytes: 0, shadowBytes: 0, thresholdBytes: 0, overThreshold: false },
        };
      }
      if (prop === "listAgentTools") return { tools: [] };
      if (prop === "listQueuedAgentMessages") return { messages: [] };
      if (prop === "listChatModels") return { models: [] };
      if (prop === "getAgentPermissions") return { mode: "smart" };
      return {};
    },
  };
  return { rpcClient: new Proxy({}, handler) };
});

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { AgentConversation } = await import("./conversation");
const { useAgentStore } = await import("@stores/agent");
const { useChatStore } = await import("@stores/chat");

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

afterEach(async () => {
  // 必须卸载：追平的 4 秒轮询不停的话，React 的调度会在 DOM 全局被还原之后再跑。
  if (mounted) {
    const { root } = mounted;
    mounted = null;
    await act(async () => {
      root.unmount();
    });
  }
  for (const el of Array.from(document.body.children)) el.remove();
  calls.length = 0;
  eventFullReturn = [];
  fullQueryPending = false;
  useChatStore.getState().setActiveConversation(null);
  useAgentStore.getState().clear();
});

/** 当前挂着的这棵树（afterEach 负责卸载）。 */
let mounted: { root: ReturnType<typeof createRoot>; container: HTMLElement } | null = null;

async function mountConversation(running: boolean) {
  useChatStore.getState().setActiveConversation(CONVERSATION_ID);
  useChatStore.getState().setActiveMessages([]);
  useChatStore.getState().setStreaming(false);
  useAgentStore.getState().setConversationId(null);
  useAgentStore.getState().setMode("agent");
  useAgentStore.getState().setRunning(running);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  mounted = { root, container };
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(AgentConversation, { conversationId: CONVERSATION_ID, defaultWorkspace: "/tmp/ws" }),
      ),
    );
  });
  return client;
}

/** 不带 afterId（或 afterId 为 0）的 listAgentEvents 请求：就是「全量」请求。 */
const fullEventRequests = () =>
  calls.filter(
    (call) =>
      call.method === "listAgentEvents" &&
      ((call.params as { afterId?: number })?.afterId === undefined ||
        (call.params as { afterId?: number })?.afterId === 0),
  );

/** 带着 afterId（>0）的 listAgentEvents 请求：增量追平。 */
const incrementalEventRequests = () =>
  calls.filter((call) => {
    if (call.method !== "listAgentEvents") return false;
    const afterId = (call.params as { afterId?: number })?.afterId;
    return afterId != null && afterId > 0;
  });

test("打开会话：首次全量查询还在飞时，不带 afterId 的请求只有 1 次（不会多发一遍全量）", async () => {
  // 让全量查询永远挂起（模拟“还在飞”），这样 isSuccess 一直 false，
  // 追平 effect 应只发一次全量（来自 eventsQuery 的 queryFn 本身），不发第二次。
  fullQueryPending = true;
  await mountConversation(false);
  // 给追平 effect 的执行窗口：修之前这里会数到 2 次全量（eventsQuery + afterId=0 的追平）。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  // 只应看到 1 次不带 afterId 的请求（eventsQuery 的 queryFn），不应该有第二次（追平）。
  expect(fullEventRequests().length).toBe(1);
});

test("首次全量落地之后，空会话也会追平一次（afterId 为 0 的请求）", async () => {
  // 空会话：全量返回空数组（eventFullReturn=[]），store 一直为空。
  // 落地的信号是 eventsQuery.isSuccess（而不是 store 里有没有事件）——
  // 否则空会话会永远不追平，丢掉的推送就补不回来。
  // fullQueryPending=false，queryFn 正常 resolve（返回空数组）。
  await mountConversation(false);
  // 让 queryFn 的 promise resolve（在 act 里 microtask 队列已排干，isSuccess 应该 true）。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  // 落地后 catchUp 重跑，发一次 afterId=0 的追平（空会话从 0 追平是对的）。
  // 注意：eventsQuery 的 queryFn 本身也会发一次不带 afterId 的请求（=1 次），
  // 追平会再发一次（=2 次）。断言 total > 1 证明追平确实发生了。
  expect(fullEventRequests().length).toBeGreaterThan(1);
});

test("首次全量落地之后，有事件的会话追平发的是带 afterId 的增量请求", async () => {
  // mock 的全量（不带 afterId）返回 id=1/2 两条事件：eventsQuery 落地 → setEvents
  // 把这两条写进 store → 追平 effect 靠 eventsQuery.isSuccess 重跑 → catchUp 看到
  // known 非空，发出带 afterId=2 的增量请求（而不是又一次全量）。
  eventFullReturn = [event(1), event(2)];
  await mountConversation(false);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  // 落地后 catchUp 发增量请求（afterId=2），而不是又一次全量。
  expect(incrementalEventRequests().length).toBeGreaterThan(0);
  // 增量请求的 afterId 取自已知事件的最大 id。
  expect(
    incrementalEventRequests().some((c) => (c.params as { afterId?: number }).afterId === 2),
  ).toBe(true);
});
