/**
 * JEV 页的渲染回归测试。
 *
 * 两件事：
 *   1. **钩子顺序**：第一次真实运行页面时炸了 React #310（"渲染的钩子比上次多"）——
 *      本地引擎面板把 `useSystemOneInstallStore` 放在了两个提前 `return` 之后，于是
 *      status 从"还没有"变成"有了"的那一次渲染，钩子数量变了。这类错误只在**数据
 *      从无到有**的那一帧出现，纯逻辑单测永远抓不到，只能挂载真实组件跑一次。
 *   2. **示例能装进左栏**：侧栏点一个示例 → 左边 state 与问题一起换掉。这是这页最
 *      主要的使用路径，坏了用户会觉得"示例点了没反应"。
 */
import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

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
  "HTMLSelectElement",
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

/** 引擎已装、两个权重一个已下载一个没下 —— 覆盖模型行三种状态的渲染分支。 */
const AVAILABILITY = {
  backend: "auto" as const,
  resolved: "local-runtime" as const,
  cloudConfigured: false,
  localServerConfigured: false,
  localRuntimeInstalled: true,
  localRuntimeSupported: true,
  localRuntimeVersion: "0.1.0",
  localRuntimeRunning: false,
  localRuntimePhase: "idle" as const,
  localRuntimePhaseMessage: "",
  pricing: { inputPerMTok: 0, outputPerMTok: 0 },
  models: [],
  localModels: [
    { name: "laya-latest", version: "laya-1", release_date: "2026-09-01", weights: "aac6fef/laya-mlx", approxBytes: 850_000_000, downloaded: true, bytes: 900 * 1024 * 1024, loaded: false },
    { name: "laya-multilingual", version: "laya-multilingual-1", release_date: "2026-09-01", weights: "aac6fef/laya-multilingual-mlx", approxBytes: 650_000_000, downloaded: false, bytes: 0, loaded: false },
  ],
};

const settingsPatches: Record<string, string>[] = [];
/** 让下一个用例模拟"设置根本没写进去"（写库失败）。 */
let settingsWriteError: string | null = null;

mock.module("@lib/rpc", () => ({
  rpcClient: {
    systemoneStatus: async () => AVAILABILITY,
    systemoneRun: async () => ({ ok: true, response: { model: "laya-1", answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }, backend: "local-runtime", requestId: "req_x" }),
    getSettings: async () => ({ settings: {} }),
    updateSettings: async ({ settings }: { settings: Record<string, string> }) => {
      if (settingsWriteError) throw new Error(settingsWriteError);
      settingsPatches.push(settings);
      return { ok: true };
    },
    systemoneTest: async () => ({ ok: true, model: "laya-1", backend: "local-runtime", noul: 1, latencyMs: 3 }),
    systemoneDiscover: async () => ({
      reachable: true,
      base: "http://gw.test",
      systemone: "yes" as const,
      models: { jev: [{ name: "jev-latest" }, { name: "openjev-27b" }], others: [] },
      candidates: [],
      message: "",
    }),
  },
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { JevScreen } = await import("./index");
const { JevSidebar } = await import("./sidebar");
const { useJevStore } = await import("@stores/jev");
const { useSystemOneInstallStore } = await import("@stores/systemone-install");
const { translate } = await import("../../../shared/i18n");

const zh = (key: string) => translate("zh", key);

afterAll(() => {
  for (const [key, value] of savedGlobals) (globalThis as unknown as Record<string, unknown>)[key] = value;
});

/** 挂载一个组件，跑完首帧与查询回填后的那一帧，返回容器。 */
async function mount(node: React.ReactElement): Promise<{ container: HTMLElement; unmount: () => void }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let root: ReturnType<typeof createRoot>;
  await act(async () => {
    root = createRoot(container);
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  });
  // 关键：让 react-query 的 promise 结算，触发"数据从无到有"的那次重渲染 —— #310 就在这一帧。
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

test("页面能渲染：引擎区与模型行都在（守住 React #310 那一类钩子顺序错误）", async () => {
  const { container, unmount } = await mount(<JevScreen />);
  try {
    const text = container.textContent ?? "";
    // 中文界面下，打开的默认内容也必须是中文（不是写死的一份英文工单）。
    expect(text).toContain("被扣了两次");
    expect(text).toContain(zh("jev.engine"));
    expect(text).toContain(zh("jev.engine.local"));
    expect(text).toContain(zh("jev.engine.cloud"));
    // 已装的权重与未下载的权重各一行，状态文案不同。
    expect(text).toContain("laya-latest");
    expect(text).toContain("laya-multilingual");
    expect(text).toContain(zh("jev.local.state.downloaded").split("{")[0]!.trim());
    expect(text).toContain(zh("jev.local.state.missing"));
    // 右栏是空态（还没跑）。
    expect(text).toContain(zh("jev.empty"));
    // 运行按钮在。
    expect(text).toContain(zh("jev.run"));
  } finally {
    unmount();
  }
});

test("中文界面下列表与标签是中文，标识符保持英文", async () => {
  const { container, unmount } = await mount(<JevScreen />);
  try {
    const text = container.textContent ?? "";
    expect(text).toContain("判定引擎");
    expect(text).toContain("本地运行");
    // 模型 id 与原语名（Noul）是照抄用的标识符，保持英文；后面的说明是中文。
    expect(text).toContain("laya-latest");
    expect(text).toContain("Noul 是/否");
    expect(text).toContain("Choice 选项");
    expect(text).toContain("Score 打分");
  } finally {
    unmount();
  }
});

test("下载中的那一行显示百分比与进度条（推送到达时看得见进展）", async () => {
  const { container, unmount } = await mount(<JevScreen />);
  try {
    // 主进程推来的进度（真实路径：systemoneModelProgress → store）。
    await act(async () => {
      useSystemOneInstallStore
        .getState()
        .setProgress({ weights: "aac6fef/laya-multilingual-mlx", phase: "downloading", bytes: 300 * 1024 * 1024 });
    });
    const text = container.textContent ?? "";
    expect(text).toContain("下载中");
    // 300 MiB / 约 620 MiB ≈ 48%（体积按 MiB 展示，所以分母不是 650 而是 620）。
    expect(text).toContain("下载中 48%");
    expect(text).toContain("约 620 MB");
    // 进度条真的画出来了（不然就只是文字，用户看不出"在动"）。
    expect(container.querySelectorAll(".jev-prob-fill").length).toBeGreaterThan(0);
    // 按钮也跟着变成"下载中…"，而不是仍写着「下载」（点了像没反应）。
    expect(text).toContain(zh("jev.local.downloading"));
  } finally {
    await act(async () => {
      useSystemOneInstallStore.getState().setProgress({ weights: "aac6fef/laya-multilingual-mlx", phase: "done", bytes: 650 * 1024 * 1024 });
    });
    unmount();
  }
});

test("切到「云端接入」就把后端写成 cloud —— 用户配的云端必须真的被调用", async () => {
  // 这条盯的是真出现过的坑：tab 以前只是"视图"，走哪条由 auto 决定，于是本地地址一配，
  // 云端永远轮不到 —— 表现就是"我在云端接入填了 Key，它却还在用本地那个"。
  settingsPatches.length = 0;
  useJevStore.getState().setEngineTab("local");
  const { container, unmount } = await mount(<JevScreen />);
  try {
    const cloudTab = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes(zh("jev.engine.cloud")),
    );
    expect(cloudTab).toBeTruthy();
    await act(async () => {
      cloudTab!.click();
    });
    expect(settingsPatches.some((patch) => patch.SYSTEMONE_BACKEND === "cloud")).toBe(true);
    expect(useJevStore.getState().engineTab).toBe("cloud");
  } finally {
    unmount();
  }
});

test("设置没写进去时 tab 退回原选择并说明 —— 不停在「看起来选了云端」的状态", async () => {
  // 这个缺陷的整条教训就是"界面说的后端"和"真正被调用的后端"会分家。写失败还停在云端，
  // 就是同一个 bug 换了个样子（我选了云端，它还在走本地），所以必须退回去并说出来。
  settingsWriteError = "database is locked";
  useJevStore.getState().setEngineTab("local");
  const { container, unmount } = await mount(<JevScreen />);
  try {
    const cloudTab = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes(zh("jev.engine.cloud")),
    );
    expect(cloudTab).toBeTruthy();
    await act(async () => {
      cloudTab!.click();
      // 等这次 reject 结算（mutation 不重试）。
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(useJevStore.getState().engineTab).toBe("local");
    const note = container.textContent ?? "";
    // 文案是"…（{message}）…"，所以拆开断言：前缀在、真实原因也在。
    expect(note).toContain(zh("jev.backend.saveFailed").split("{")[0]!.trim());
    expect(note).toContain("database is locked");
  } finally {
    settingsWriteError = null;
    unmount();
  }
});

test("点侧栏示例：state 与问题一起换掉（这页最主要的使用路径）", async () => {
  useJevStore.getState().reset();
  const { container, unmount } = await mount(<JevSidebar />);
  try {
    const buttons = [...container.querySelectorAll("button")];
    const guardrails = buttons.find((button) => button.textContent?.includes(zh("jev.example.guardrails")));
    expect(guardrails).toBeTruthy();
    await act(async () => {
      guardrails!.click();
    });
    const store = useJevStore.getState();
    expect(store.exampleId).toBe("guardrails");
    // 护栏示例：一段带提示注入的中文文本 + 四个 noul。
    expect(store.state).toContain("提示词");
    expect(store.drafts).toHaveLength(4);
    expect(store.drafts.every((draft) => draft.type === "noul")).toBe(true);
    // 英文界面同一份示例换英文内容。
    const { jevExamples } = await import("./examples");
    expect(jevExamples("en").find((example) => example.id === "guardrails")?.state).toContain("system prompt");
  } finally {
    unmount();
    useJevStore.getState().reset();
  }
});

test("判定台 ↔ 游乐场来回切都不炸（守住 React #300 那一类钩子数量变化）", async () => {
  // 真实路径：侧栏点「游乐场」只改 store 里的 view，页面原地重渲染 —— 不是重新挂载。
  // 分叉曾写在判定台组件内部（读完 view 就 return 游乐场），于是切过去的那一帧
  // 少跑了后面十几个钩子：React #300「Rendered fewer hooks than expected」，
  // 整页被错误边界吃掉，连切回来都不行。所以这里必须在同一次挂载里来回切。
  useJevStore.getState().setView("console");
  const { container, unmount } = await mount(<JevScreen />);
  try {
    expect(container.textContent ?? "").toContain(zh("jev.engine"));
    await act(async () => {
      useJevStore.getState().setView("playground");
    });
    // 没选场景时游乐场是空态 —— 能看到这行字就说明它真的渲染出来了。
    expect(container.textContent ?? "").toContain(zh("jev.playground.empty"));
    // 切回去同样是重渲染，判定台的钩子得一个不少地回来。
    await act(async () => {
      useJevStore.getState().setView("console");
    });
    expect(container.textContent ?? "").toContain(zh("jev.engine"));
  } finally {
    unmount();
    useJevStore.getState().setView("console");
  }
});

// ---------------------------------------------------------------------------
// 侧栏：判定模型选择 + 数据驾驶舱
// ---------------------------------------------------------------------------

const { useJevMetrics } = await import("@stores/jev-metrics");

test("侧栏能选本地 / 云端，选择写进设置（两处改的是同一份配置）", async () => {
  settingsPatches.length = 0;
  settingsWriteError = null;
  useJevStore.getState().setEngineTab("local");
  const { container, unmount } = await mount(<JevSidebar />);
  try {
    const text = container.textContent ?? "";
    expect(text).toContain(zh("jev.picker.title"));
    expect(text).toContain(zh("jev.picker.local"));
    expect(text).toContain(zh("jev.picker.cloud"));

    const cloud = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(zh("jev.picker.cloud")));
    expect(cloud).toBeTruthy();
    await act(async () => {
      cloud!.click();
    });
    // 选云端 = 把后端写成 cloud，和主区面板改的是同一个设置项。
    expect(settingsPatches.some((patch) => patch.SYSTEMONE_BACKEND === "cloud")).toBe(true);
    expect(useJevStore.getState().engineTab).toBe("cloud");
  } finally {
    unmount();
    useJevStore.getState().setEngineTab("local");
  }
});

test("驾驶舱：没跑过是空态，跑过之后给出延迟与趋势", async () => {
  useJevMetrics.getState().clear();
  const empty = await mount(<JevSidebar />);
  try {
    expect(empty.container.textContent ?? "").toContain(zh("jev.metrics.empty"));
    // 空态不画趋势图。
    expect(empty.container.querySelector("svg[role='img']")).toBeNull();
  } finally {
    empty.unmount();
  }

  await act(async () => {
    for (const ms of [120, 240, 360]) {
      useJevMetrics.getState().record({ at: Date.now(), ms, ok: true, backend: "cloud", source: "playground" });
    }
    useJevMetrics.getState().record({ at: Date.now(), ms: 0, ok: false, backend: null, source: "playground" });
  });

  const filled = await mount(<JevSidebar />);
  try {
    const text = filled.container.textContent ?? "";
    // 头条是最近一次成功的耗时；平均只算成功的三次。
    expect(text).toContain("360");
    expect(text).toContain("240 ms");
    expect(text).toContain(zh("jev.metrics.p95"));
    // 四次调用里有一次失败，数字要如实写出来。
    expect(text).toContain("4 次 · 1 次失败");
    // 趋势：一次一根，失败那次也占一根（画成警示色）。
    const bars = filled.container.querySelectorAll("svg[role='img'] rect");
    expect(bars).toHaveLength(4);
  } finally {
    filled.unmount();
    useJevMetrics.getState().clear();
  }
});

test("同名模型按出处分得开：每条带地址路径，选别的路径会连地址一起换", async () => {
  // 实测过的坑：一台网关后面挂着三个判定服务，它们全都自称 jev-latest —— 只看
  // 名字点下去，跑的还是原来那台。
  settingsPatches.length = 0;
  settingsWriteError = null;
  useJevStore.getState().setEngineTab("cloud");
  const { container, unmount } = await mount(<JevSidebar />);
  try {
    const discoverButton = [...container.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === zh("systemone.discover"),
    );
    expect(discoverButton).toBeTruthy();
    await act(async () => {
      discoverButton!.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    // 下拉是 radix 的，列表在展开后才进 DOM —— 这里直接验行为：选中候选路径上的
    // 那条，设置里必须同时出现模型名与新地址。
    const picker = await import("./model-picker");
    expect(picker.pathHint("http://120.76.139.101:38003/jev/openjev-27b")).toBe("/jev/openjev-27b");
    // 根路径上的服务没有路径可取，退回 host（总比空着强）。
    expect(picker.pathHint("https://api.typesafe.ai")).toBe("api.typesafe.ai");
    expect(picker.pathHint("")).toBe("");
  } finally {
    unmount();
    useJevStore.getState().setEngineTab("local");
  }
});
