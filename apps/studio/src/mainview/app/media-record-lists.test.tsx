import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 生图 / 视频 / OCR 三个侧栏列表的「删除」与「下载」。
 *
 * 这三个列表原先只能在「全部历史」页（OCR 是详情页）里删，下载更是只挂在结果卡片上 ——
 * 侧栏看得见记录却动不了。这里钉住四件事，四家都一样：
 *   1. 每行都有删除按钮，且点了不是直接删，而是先弹确认框；
 *   2. 确认后调用各自的 delete RPC；
 *   3. 删掉的正好是当前聚焦/打开的那条时，选中要一起收回去（否则右侧停在一条不存在的记录上）；
 *   4. 图片 / 视频 / 音乐有成品的那几行还要有下载按钮，保存的提示文案取自 i18n。
 *
 * 下载按钮本身只断言存在与可点：真正的落盘在 `saveImageToDownloads` / `saveAudioToFolder`
 * 两个 RPC 里，属于主进程侧。
 *
 * **音乐不在这里**：它的侧栏已经换成歌单栏，逐条的删除 / 下载搬到了歌单曲目页 ——
 * 那两件事现在属于 `app/music/music-playlists.test.tsx`。
 */

// happy-dom 提供真实 DOM（组件要用 document / MouseEvent），afterAll 还原全局。
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

const deleted: { kind: string; id: number }[] = [];
const saved: { url: string; filename: string }[] = [];

let imageRecords: unknown[] = [];
let videoRecords: unknown[] = [];
let documents: unknown[] = [];

mock.module("@lib/rpc", () => ({
  rpcClient: {
    listImageRecords: async () => ({ records: imageRecords }),
    listVideoRecords: async () => ({ records: videoRecords }),
    getDocuments: async () => ({ documents, total: documents.length }),
    deleteImageRecord: async ({ id }: { id: number }) => {
      deleted.push({ kind: "image", id });
      return { ok: true };
    },
    deleteVideoRecord: async ({ id }: { id: number }) => {
      deleted.push({ kind: "video", id });
      return { ok: true };
    },
    deleteDocument: async ({ id }: { id: number }) => {
      deleted.push({ kind: "document", id });
      return { ok: true };
    },
    saveImageToDownloads: async (params: { url: string; filename: string }) => {
      saved.push(params);
      return { ok: true, path: `/tmp/Downloads/${params.filename}` };
    },
    saveAudioToFolder: async (params: { url: string; filename: string }) => {
      saved.push(params);
      return { ok: true, path: `/tmp/Downloads/${params.filename}` };
    },
  },
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("@ui/tooltip");
const { SidebarProvider } = await import("@ui/sidebar");
const { ImageRecordList } = await import("./image/record-list");
const { VideoRecordList } = await import("./video/record-list");
const { OcrRecordList } = await import("./ocr/record-list");
const { useImageStore } = await import("@stores/image");
const { useVideoStore } = await import("@stores/video");
const { useRouter } = await import("@stores/router");
const { translate } = await import("../../shared/i18n");

const zh = (key: string) => translate("zh", key);
const DELETE = zh("common.delete");
const DOWNLOAD = zh("common.download");

function byTitle(container: HTMLElement, title: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[title="${title}"]`);
}

/**
 * 下载按钮的提示是 Radix tooltip（浮层里才渲染），DOM 上留下的是 aria-label ——
 * 也正好是读屏用户听到的那个名字。
 */
function byLabel(container: HTMLElement, label: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
}

function countLabel(container: HTMLElement, label: string): number {
  return container.querySelectorAll(`[aria-label="${label}"]`).length;
}

/** 确认框走 Radix Portal，挂在 document.body 上，不在被测容器里。 */
function dialogText(): string {
  return document.body.textContent ?? "";
}

/** 确认框里的「删除」是唯一一个文本恰好等于「删除」的按钮（行内那颗是图标按钮）。 */
function confirmButton(): HTMLButtonElement {
  return [...document.body.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === DELETE,
  )!;
}

async function settle() {
  // 列表数据是 useQuery 拉回来的：react-query 自己排了一拍调度，微任务不够，
  // 得让宏任务也跑一轮，否则拿到的是 loading 态（列表是空的）。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: InstanceType<typeof QueryClient>;

beforeEach(() => {
  deleted.length = 0;
  saved.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(element: React.ReactElement) {
  await act(async () => {
    // 侧栏里的下载按钮 / SidebarMenuButton 都带 tooltip，没 Provider 会直接抛。
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          TooltipProvider,
          null,
          createElement(SidebarProvider, null, element),
        ),
      ),
    );
  });
  await settle();
}

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
});

// ---------------------------------------------------------------------------
// 生图
// ---------------------------------------------------------------------------

test("生图侧栏：每行都能删、有图的能下，删的是聚焦中的那条时收起选中", async () => {
  imageRecords = [
    { id: 1, prompt: "第一张图", imageUrl: "http://127.0.0.1:1/images/gen/a.png", status: "done", createdAt: Date.now() },
    { id: 2, prompt: "失败的图", imageUrl: null, status: "failed", createdAt: Date.now() },
  ];
  useImageStore.setState({ focusRecordId: 2 });

  await render(createElement(ImageRecordList));

  // 两张都找得到删除按钮；只有有成品的那张带下载。
  expect(container.querySelectorAll(`[title="${DELETE}"]`).length).toBe(2);
  expect(countLabel(container, zh("image.result.download"))).toBe(1);

  // 删除是「先问一句」，点下去不能直接调 RPC。
  await act(async () => {
    byTitle(container, DELETE)!.click();
  });
  expect(deleted).toEqual([]);
  expect(dialogText()).toContain(zh("image.history.deleteTitle"));

  // 确认框里再点删除才真的删；失败记录没有图，也不该挡住删除。
  const confirm = confirmButton();
  await act(async () => {
    confirm.click();
    await Promise.resolve();
  });
  expect(deleted).toEqual([{ kind: "image", id: 1 }]);
  // 删的不是聚焦那条（id 2），选中要留着。
  expect(useImageStore.getState().focusRecordId).toBe(2);
});

test("生图侧栏：删掉聚焦中的那条后，聚焦被清空", async () => {
  imageRecords = [
    { id: 7, prompt: "就是它", imageUrl: "http://127.0.0.1:1/images/gen/x.png", status: "done", createdAt: Date.now() },
  ];
  useImageStore.setState({ focusRecordId: 7 });

  await render(createElement(ImageRecordList));
  await act(async () => {
    byTitle(container, DELETE)!.click();
  });
  const confirm = confirmButton();
  await act(async () => {
    confirm.click();
    await Promise.resolve();
  });

  expect(deleted).toEqual([{ kind: "image", id: 7 }]);
  expect(useImageStore.getState().focusRecordId).toBeNull();
});

test("生图侧栏：下载按钮把请求交给 saveImageToDownloads，文件名带记录 id", async () => {
  imageRecords = [
    { id: 42, prompt: "带 id", imageUrl: "http://127.0.0.1:1/images/gen/y.png", status: "done", createdAt: Date.now() },
  ];
  await render(createElement(ImageRecordList));

  await act(async () => {
    byLabel(container, zh("image.result.download"))!.click();
    await Promise.resolve();
  });

  expect(saved.length).toBe(1);
  expect(saved[0]!.url).toBe("http://127.0.0.1:1/images/gen/y.png");
  expect(saved[0]!.filename).toContain("image-42-");
});

// ---------------------------------------------------------------------------
// 视频 / 音乐
// ---------------------------------------------------------------------------

test("视频侧栏：能删能下，且用 video-<id> 命名", async () => {
  videoRecords = [
    { id: 3, prompt: "一段视频", videoUrl: "http://127.0.0.1:1/images/videos/v.mp4", status: "done", createdAt: Date.now() },
    { id: 4, prompt: "还在跑", videoUrl: null, status: "processing", createdAt: Date.now() },
  ];
  useVideoStore.setState({ focusRecordId: 3 });
  await render(createElement(VideoRecordList));

  expect(container.querySelectorAll(`[title="${DELETE}"]`).length).toBe(2);
  expect(byLabel(container, zh("video.result.download")) !== null).toBe(true);

  await act(async () => {
    byTitle(container, DELETE)!.click();
  });
  expect(dialogText()).toContain(zh("video.history.deleteTitle"));
  const confirm = confirmButton();
  await act(async () => {
    confirm.click();
    await Promise.resolve();
  });
  expect(deleted).toEqual([{ kind: "video", id: 3 }]);
  expect(useVideoStore.getState().focusRecordId).toBeNull();

  await act(async () => {
    byLabel(container, zh("video.result.download"))!.click();
    await Promise.resolve();
  });
  expect(saved[0]!.filename).toContain("video-3-");
  expect(saved[0]!.filename.endsWith(".mp4")).toBe(true);
});

// ---------------------------------------------------------------------------
// OCR
// ---------------------------------------------------------------------------

test("OCR 侧栏：能删；删的是详情页正在看的那份时退回列表", async () => {
  documents = [
    { id: 11, name: "报告.pdf", kind: "pdf", preview: "第一页的内容", status: "completed" },
    { id: 12, name: "票据.png", kind: "image", preview: "", status: "completed" },
  ];
  useRouter.setState({ route: { path: "document", id: 11 } });

  await render(createElement(OcrRecordList));

  expect(container.querySelectorAll(`[title="${DELETE}"]`).length).toBe(2);

  await act(async () => {
    byTitle(container, DELETE)!.click();
  });
  expect(deleted).toEqual([]);
  expect(dialogText()).toContain(zh("ocr.docs.deleteTitle"));

  const confirm = confirmButton();
  await act(async () => {
    confirm.click();
    await Promise.resolve();
  });

  expect(deleted).toEqual([{ kind: "document", id: 11 }]);
  expect(useRouter.getState().route).toEqual({ path: "index" });
});

test("OCR 侧栏：删的不是当前打开的那份时，留在详情页", async () => {
  documents = [{ id: 21, name: "甲.pdf", kind: "pdf", preview: "甲", status: "completed" }];
  useRouter.setState({ route: { path: "document", id: 99 } });

  await render(createElement(OcrRecordList));
  await act(async () => {
    byTitle(container, DELETE)!.click();
  });
  const confirm = confirmButton();
  await act(async () => {
    confirm.click();
    await Promise.resolve();
  });

  expect(useRouter.getState().route).toEqual({ path: "document", id: 99 });
});

// ---------------------------------------------------------------------------
// 按钮自身的文案
// ---------------------------------------------------------------------------

test("下载按钮的默认提示来自 common.download，不泄露原始 key", async () => {
  const { MediaDownloadButton } = await import("@components/record-actions");
  await render(
    createElement(MediaDownloadButton, { save: async () => ({ ok: true, path: "/tmp/x.png" }) }),
  );

  expect(byLabel(container, DOWNLOAD) !== null).toBe(true);
  expect(container.textContent).not.toContain("common.download");
});
