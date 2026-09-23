import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

// 下载面板的下拉列表要为「下载记录」负责：整份历史都必须渲染出来，并且落在
// 一个真正能滚动的容器里。曾经的问题是容器只有 max-h、滚动区没有确定高度，
// Radix 视口被内容撑开后被根的 overflow 裁掉 —— 14 条记录只看得见 2 条，
// 也没法下拉。这个文件锁住结构，避免再退化。
//
// 现在列表按「模型」聚合（一个模型一行、一个进度）：多文件仓库的十几个分片
// 合并成一条，GGUF 每个量化各占一行。断言随之改成按模型而不是按文件。
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
  "HTMLSpanElement",
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

type Task = {
  id: string;
  repo: string;
  fileName: string;
  source: "modelscope" | "huggingface";
  status: "queued" | "downloading" | "paused" | "completed" | "failed" | "canceled";
  received: number;
  total: number | null;
  percent: number | null;
  speed: number;
  error?: string;
  createdAt: number;
  size?: number | null;
  order?: number;
};

// 多文件模型：仓库里的 14 个文件属于**同一个模型**，面板上必须只占一行。
const REPO = "mlx-community/MiniCPM5-2B-mlx-4Bit";
const repoFileName = "tokenizer.json";
const fileNames = [
  repoFileName,
  "configuration.json",
  "generation_config.json",
  "tokenizer_config.json",
  "config.json",
  "chat_template.jinja",
  "model.safetensors.index.json",
  "model.safetensors",
  "special_tokens_map.json",
  "vocab.json",
  "merges.txt",
  "tokenizer.model",
  "added_tokens.json",
  "preprocessor_config.json",
];
// 14 个文件：12 个下完、2 个失败（最新）→ 一行 + 「12/14 个文件」+ 失败提示。
const multiFileTasks: Task[] = [
  {
    id: "t-failed-new",
    repo: REPO,
    fileName: "tokenizer.json",
    source: "modelscope",
    status: "failed",
    received: 0,
    total: null,
    percent: 0,
    speed: 0,
    error: "Download failed: 500",
    createdAt: 200,
    size: null,
  },
  {
    id: "t-failed-old",
    repo: REPO,
    fileName: "configuration.json",
    source: "modelscope",
    status: "failed",
    received: 0,
    total: null,
    percent: 0,
    speed: 0,
    error: "Download failed: 500",
    createdAt: 199,
    size: null,
  },
  ...fileNames
    .slice(2)
    .map((fileName, i) => ({
      id: `t-done-${i}`,
      repo: REPO,
      fileName,
      source: "modelscope" as const,
      status: "completed" as const,
      received: 1024,
      total: 1024,
      percent: 100,
      speed: 0,
      createdAt: 100 - i,
      size: 1024,
    })),
];

// 另外几个模型（已完成的历史），凑够长度验证「整份记录都渲染 + 列表真的能滚」。
const historyRepos = [
  "Qwen/Qwen3.5-4B",
  "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B",
  "k2-fsa/OmniVoice",
  "openai/whisper-large-v3-turbo",
  "Lightricks/LTX-2",
  "z-lab/Qwen3-4B-Flash-b16",
  "OpenMOSS-Team/MOSS-TTS-Nano",
  "apple/mobileclip2-b",
];
const historyTasks: Task[] = historyRepos.map((repo, i) => ({
  id: `t-hist-${i}`,
  repo,
  fileName: "model.safetensors",
  source: "modelscope" as const,
  status: "completed" as const,
  received: 2048,
  total: 2048,
  percent: 100,
  speed: 0,
  createdAt: 50 - i,
  size: 2048,
}));

const tasks: Task[] = [...multiFileTasks, ...historyTasks];

const listDownloadsCalls: number[] = [];
mock.module("@lib/rpc", () => ({
  rpcClient: {
    listDownloads: async () => {
      listDownloadsCalls.push(Date.now());
      return { tasks };
    },
    removeDownload: async () => ({ ok: true }),
    pauseModelDownload: async () => ({ ok: true }),
    resumeModelDownload: async () => ({ ok: true }),
    cancelModelDownload: async () => ({ ok: true }),
  },
}));

const { act } = await import("react");
const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("./ui/tooltip");
const { DownloadsButton } = await import("./download-panel");
const { useModelDownloadStore } = await import("@stores/model-download");
afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

function textOf(node: Element): string {
  return (node.textContent ?? "").replace(/\s+/g, " ");
}

/** 渲染面板、点开下载按钮，拿到下拉容器。 */
async function openPanel() {
  useModelDownloadStore.getState().setTasks([]);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TooltipProvider, null, createElement(DownloadsButton)),
      ),
    );
    // 等 listDownloads 的 promise 落地，任务列表进 store。
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  // 面板里初始只有一个按钮：下载管理触发器（tooltip 只走 Radix，不落 aria-label）。
  const trigger = container.querySelector("button") as unknown as HTMLElement;
  expect(trigger).not.toBeNull();
  await act(async () => {
    trigger.click();
  });

  return {
    container,
    popover: () => {
      // 结构定位：下拉容器是滚动区的父节点（不依赖标题层级，之前用标题的
      // parentElement 链定位，改一次表头就找不到了）。
      const scrollArea = document.querySelector("[data-slot='scroll-area']");
      expect(scrollArea).not.toBeNull();
      const popover = scrollArea!.parentElement as unknown as HTMLElement;
      expect(popover.className).toContain("w-80");
      return popover;
    },
    close: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

test("下载记录整份渲染：每个模型一行，多文件仓库合成一条", async () => {
  const panel = await openPanel();
  try {
    expect(listDownloadsCalls.length).toBeGreaterThan(0);
    const popover = panel.popover();
    const text = textOf(popover as unknown as Element);

    // 每个模型都出现（历史一屏放不下，但整份都在 DOM 里）。
    for (const repo of historyRepos) {
      expect(text).toContain(repo.split("/").pop()!);
    }
    expect(text).toContain("MiniCPM5-2B-mlx-4Bit");

    // 多文件仓库的 14 个文件是**同一个模型**：面板上是 1 行，不是 14 行。
    expect(text).toContain("12/14 个文件");
    // 逐文件的名字不再出现在面板上（用户看的是模型整体进度）。
    expect(text).not.toContain("preprocessor_config.json");

    // 面板标题上的计数 = 模型数（1 个多文件模型 + N 个单文件模型）。
    expect(text).toContain(`(${1 + historyRepos.length})`);

    // 滚动视口存在（Appica ScrollArea = Base UI，viewport 带 data-slot），且列表挂在它下面。
    const viewport = popover.querySelector("[data-slot='scroll-area-viewport']");
    expect(viewport).not.toBeNull();
    expect(textOf(viewport as unknown as Element)).toContain("mobileclip2-b");
  } finally {
    await panel.close();
  }
});

test("列表容器高度有上限且滚动区拿到确定高度：视口才能出现滚动条", async () => {
  const panel = await openPanel();
  try {
    const popover = panel.popover();
    const popoverClass = popover.className;
    // 祖先盒子（flex 列 + 上限高度）必须先约束住自己，列表才有确定的可用高度。
    expect(popoverClass).toContain("flex-col");
    expect(popoverClass).toContain("h-[min(");

    const scrollArea = popover.querySelector("[data-slot='scroll-area']") as HTMLElement;
    expect(scrollArea).not.toBeNull();
    // Radix 视口是 height:100%，只有滚动区自己带确定高度（或祖先确定高度 + 自身
    // max-h）时才会解析成滚动高度；实测只给祖先 max-h 时视口被内容撑开、被裁掉。
    expect(scrollArea.className).toContain("h-[min(");
    expect(scrollArea.className).toContain("min-h-0");
    expect(scrollArea.className).not.toContain("max-h-");

    const viewport = popover.querySelector("[data-slot='scroll-area-viewport']") as HTMLElement;
    expect(viewport.className).toContain("min-h-0");
  } finally {
    await panel.close();
  }
});

test("有失败/正在下的模型排在最前、已完成的历史按时间倒序跟在后面", async () => {
  const panel = await openPanel();
  try {
    const text = textOf(panel.popover() as unknown as Element);
    // 失败的模型是「活跃」组，必须排在所有已完成历史之前。
    const active = text.indexOf("MiniCPM5-2B-mlx-4Bit");
    const firstHistory = text.indexOf(historyRepos[0]!.split("/").pop()!);
    expect(active).toBeGreaterThan(-1);
    expect(firstHistory).toBeGreaterThan(-1);
    expect(active).toBeLessThan(firstHistory);
    // 历史里更新的在前。
    const newer = text.indexOf(historyRepos[0]!.split("/").pop()!);
    const older = text.indexOf(historyRepos[1]!.split("/").pop()!);
    expect(newer).toBeLessThan(older);
  } finally {
    await panel.close();
  }
});
