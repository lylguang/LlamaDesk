/**
 * 「让 Agent 诊断」的行为测试。
 *
 * 这个按钮是出错之后的唯一出口，它要么带着**够用的现场**把人送到 Agent，要么就是
 * 一个摆设。所以这里盯三件事，缺一条都算坏：
 *   1. 出错时它才出现（没出错不该有这个按钮）；
 *   2. 点下去开的是**新会话**，不是往当前会话里插一段；
 *   3. 带过去的现场足够排查：报错原文、运行时状态、安装日志末尾 —— 而且是**填进
 *      输入框**、不自动发出去（诊断要动这台机器上的环境，发不发由用户定）。
 *
 * 第 3 条是本会话排查同一个问题时一条条手动去查的东西，写死在这里免得以后被精简掉。
 */
import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost/" });
const DOM_GLOBALS = [
  "window", "document", "navigator", "location", "history", "localStorage",
  "HTMLElement", "HTMLDivElement", "HTMLButtonElement", "HTMLInputElement", "HTMLTextAreaElement",
  "HTMLSelectElement", "Element", "Node", "Text", "DocumentFragment", "SVGElement", "DOMRect",
  "CustomElementRegistry", "Event", "CustomEvent", "MouseEvent", "PointerEvent", "KeyboardEvent",
  "FocusEvent", "InputEvent", "MutationObserver", "ResizeObserver", "NodeFilter",
  "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle", "matchMedia",
] as const;
const savedGlobals = new Map<string, unknown>();
for (const key of DOM_GLOBALS) {
  const value = (dom as unknown as Record<string, unknown>)[key];
  if (value === undefined) continue;
  savedGlobals.set(key, (globalThis as unknown as Record<string, unknown>)[key]);
  (globalThis as unknown as Record<string, unknown>)[key] = value;
}
(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/** 本地引擎已装、权重也下好了 —— 点「启动」时 worker 挂掉，正好用来造出错现场。 */
const STATUS = {
  backend: "local" as const,
  resolved: "local-runtime" as const,
  cloudConfigured: false,
  localServerConfigured: false,
  localRuntimeInstalled: true,
  localRuntimeSupported: true,
  localRuntimeVersion: "0.2.0",
  localRuntimeRunning: false,
  localRuntimePhase: "idle" as const,
  localRuntimePhaseMessage: "",
  pricing: { inputPerMTok: 0, outputPerMTok: 0 },
  models: [],
  localModels: [
    {
      name: "laya-latest",
      version: "laya-1",
      release_date: "2026-09-01",
      weights: "aac6fef/laya-mlx",
      approxBytes: 850_000_000,
      downloaded: true,
      bytes: 850_000_000,
      loaded: false,
    },
  ],
};

const START_ERROR = "laya worker 退出（退出码 1）";
const createdSessions: unknown[] = [];

mock.module("@lib/rpc", () => ({
  rpcClient: {
    systemoneStatus: async () => STATUS,
    getSettings: async () => ({ settings: { SYSTEMONE_BACKEND: "local" } }),
    updateSettings: async () => ({ ok: true }),
    // 权重没下就启动 —— 真实世界里就是这条路径报错。
    systemoneStartModel: async () => ({ ok: false, error: START_ERROR }),
    systemoneDownloadModel: async () => ({ ok: true }),
    systemoneStopModel: async () => ({ ok: true }),
    systemoneInstallRuntime: async () => ({ ok: true }),
    systemoneUninstallRuntime: async () => ({ ok: true }),
    systemoneInstallDeps: async () => ({ ok: true, tool: "already" }),
    getAgentWorkspace: async () => ({ workspace: "/Users/me/work" }),
    createAgentSession: async (params: unknown) => {
      createdSessions.push(params);
      return {
        session: {
          id: 4242,
          title: "新任务",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          workspace: null,
        },
      };
    },
  },
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { EngineSelector } = await import("./engine-panel");
const { useJevStore } = await import("@stores/jev");
const { useChatStore } = await import("@stores/chat");
const { useAppStore } = await import("@stores/app");
const { useRouter } = await import("@stores/router");
const { useSystemOneInstallStore } = await import("@stores/systemone-install");
const { translate } = await import("../../../shared/i18n");

const zh = (key: string) => translate("zh", key);

afterAll(() => {
  for (const [key, value] of savedGlobals) (globalThis as unknown as Record<string, unknown>)[key] = value;
});

async function mountPanel(): Promise<{ container: HTMLElement; unmount: () => void }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let root: ReturnType<typeof createRoot>;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={client}>
        <EngineSelector />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(label)) as
    | HTMLButtonElement
    | undefined;
}

test("出错之前没有诊断按钮，出错之后才出现", async () => {
  useJevStore.getState().setEngineTab("local");
  const { container, unmount } = await mountPanel();
  try {
    expect(findButton(container, zh("jev.local.diagnose"))).toBeUndefined();

    // 点「启动」：worker 起不来时就是这条路报错。
    await act(async () => {
      findButton(container, zh("jev.local.start"))!.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(container.textContent ?? "").toContain(START_ERROR);
    expect(findButton(container, zh("jev.local.diagnose"))).toBeTruthy();
  } finally {
    unmount();
  }
});

test("点诊断：开新会话、把现场填进输入框、切到 Agent —— 但不自动发出去", async () => {
  createdSessions.length = 0;
  useChatStore.getState().setPendingPrompt(null);
  useAppStore.getState().setActiveApp("jev");
  useRouter.getState().setRoute({ path: "settings" });
  useJevStore.getState().setEngineTab("local");
  // 安装日志里放一条能认出来的行，验证现场确实被带过去了。
  useSystemOneInstallStore.getState().clearLogs();
  useSystemOneInstallStore.getState().appendLines(["$ uv venv --allow-existing --python 3.12"]);

  const { container, unmount } = await mountPanel();
  try {
    await act(async () => {
      findButton(container, zh("jev.local.start"))!.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await act(async () => {
      findButton(container, zh("jev.local.diagnose"))!.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    // 1) 开的是新会话（而不是往当前会话里插）。
    expect(createdSessions).toHaveLength(1);

    // 2) 现场填进了输入框草稿，而不是被发出去。
    const prompt = useChatStore.getState().pendingPrompt ?? "";
    expect(prompt).toContain(START_ERROR);
    expect(prompt).toContain("0.2.0"); // 运行时版本
    expect(prompt).toContain(zh("jev.local.diagnosePrompt").slice(0, 12));
    // 安装日志末尾也一并带过去 —— 卡在哪一步全写在这几行里。
    expect(prompt).toContain("uv venv --allow-existing");

    // 3) 视图切到了 Agent，用户一抬头就在能回答的地方 —— 而且路由也要回到主区：
    //    从「设置」里点下去时只切 activeApp，界面纹丝不动（真机上踩到过）。
    expect(useAppStore.getState().activeApp).toBe("agent");
    expect(useRouter.getState().route.path).toBe("index");
  } finally {
    unmount();
    useChatStore.getState().setPendingPrompt(null);
    useAppStore.getState().setActiveApp("jev");
  }
});
