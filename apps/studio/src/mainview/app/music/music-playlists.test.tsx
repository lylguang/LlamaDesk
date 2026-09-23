/**
 * 音乐歌单栏 / 歌单曲目页 / 播放器 store 的行为。
 *
 * 这几处都是"错了就是功能坏了"的点，且都不靠肉眼看出来：
 *  - 侧栏里默认歌单不给改名 / 删除（后端也会拒，界面不该先摆按钮）；
 *  - 新建 / 删除走哪个 RPC、删除前必须确认；
 *  - 点曲目行 = 把**整个歌单**当队列开始播（不是只播那一首，否则"下一首"没得走）；
 *  - 生成中的曲目点不动，但要留在队列里（灰掉而不是消失）；
 *  - 队列全不可播时给出可读的错误，而不是静默无反应。
 *
 * happy-dom 提供真实 DOM（Radix 的 portal / 对话框要用 document），afterAll 还原全局。
 */
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
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
  "HTMLMediaElement",
  "HTMLAudioElement",
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
  "Audio",
] as const;
const savedGlobals = new Map<string, unknown>();
for (const key of DOM_GLOBALS) {
  const value = (dom as unknown as Record<string, unknown>)[key];
  if (value === undefined) continue;
  savedGlobals.set(key, (globalThis as unknown as Record<string, unknown>)[key]);
  (globalThis as unknown as Record<string, unknown>)[key] = value;
}
(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
});

// ---------------------------------------------------------------------------
// RPC 替身
// ---------------------------------------------------------------------------

type PlaylistRow = {
  id: number;
  name: string;
  builtin: boolean;
  count: number;
  coverSeeds: { id: number; title: string }[];
  createdAt: number;
  updatedAt: number;
};

type TrackRow = {
  id: number;
  title: string;
  status: "done" | "processing" | "failed";
  audioUrl: string | null;
  durationMs: number | null;
  lyrics: string | null;
  rewrittenLyrics: string | null;
  instrumental: boolean;
  task: "text_to_music" | null;
  source: string;
  caption: string;
  model: string;
  createdAt: number;
};

let playlists: PlaylistRow[] = [];
let tracks: TrackRow[] = [];
let nextPlaylistId = 100;

const calls: { method: string; params: unknown }[] = [];

const { translate } = await import("../../../shared/i18n");
const zh = (key: string, params?: Record<string, string>) => translate("zh", key, params);

mock.module("@lib/rpc", () => ({
  rpcClient: {
    listMusicPlaylists: async () => ({ playlists }),
    listMusicPlaylistTracks: async () => ({ records: tracks }),
    createMusicPlaylist: async (params: { name: string }) => {
      calls.push({ method: "createMusicPlaylist", params });
      const created: PlaylistRow = {
        id: nextPlaylistId++,
        name: params.name,
        builtin: false,
        count: 0,
        coverSeeds: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      playlists = [...playlists, created];
      return { ok: true, playlist: created };
    },
    renameMusicPlaylist: async (params: { id: number; name: string }) => {
      calls.push({ method: "renameMusicPlaylist", params });
      return { ok: true };
    },
    deleteMusicPlaylist: async (params: { id: number }) => {
      calls.push({ method: "deleteMusicPlaylist", params });
      playlists = playlists.filter((p) => p.id !== params.id);
      return { ok: true };
    },
    addMusicToPlaylist: async (params: { playlistId: number; recordIds: number[] }) => {
      calls.push({ method: "addMusicToPlaylist", params });
      return { ok: true, added: params.recordIds.length };
    },
    removeMusicFromPlaylist: async (params: { playlistId: number; recordId: number }) => {
      calls.push({ method: "removeMusicFromPlaylist", params });
      return { ok: true };
    },
    musicRecordPlaylistIds: async (params: { recordIds: number[] }) => {
      calls.push({ method: "musicRecordPlaylistIds", params });
      return { entries: params.recordIds.map((recordId) => ({ recordId, playlistIds: [] })) };
    },
    listMusicRecords: async () => ({ records: tracks }),
    generateMusicCover: async (params: { id: number }) => {
      calls.push({ method: "generateMusicCover", params });
      return { ok: true, coverUrl: `http://127.0.0.1:1/images/music/covers/${params.id}.webp` };
    },
    setMusicCover: async (params: { id: number; path: string }) => {
      calls.push({ method: "setMusicCover", params });
      return { ok: true, coverUrl: "http://127.0.0.1:1/images/music/covers/uploaded.webp" };
    },
    clearMusicCover: async (params: { id: number }) => {
      calls.push({ method: "clearMusicCover", params });
      return { ok: true };
    },
    openFileDialog: async () => ({ paths: ["/tmp/pick.png"] }),
  },
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("@ui/tooltip");
const { SidebarProvider } = await import("@ui/sidebar");
const { MusicPlaylistSidebar } = await import("./playlist-sidebar");
const { PlaylistView } = await import("./playlist-view");
const { MusicPlayerBar } = await import("./player-bar");
const { parseLyrics, estimatedLineTime, parseLrc, currentLrcIndex } = await import("./lyrics");
const { useMusicStore } = await import("@stores/music");
const { useMusicPlayer } = await import("@stores/music-player");
const { useMusicPlayer: playerStore } = await import("@stores/music-player");

// ---------------------------------------------------------------------------
// 渲染脚手架（与 media-record-lists.test.tsx 一致的最小可渲染环境）
// ---------------------------------------------------------------------------

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;

async function settle() {
  // 列表数据是 useQuery 拉回来的：react-query 自己排了一拍调度，微任务不够，
  // 得让宏任务也跑一轮，否则拿到的是 loading 态（列表是空的）。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          TooltipProvider,
          null,
          createElement(SidebarProvider, null, node as never),
        ),
      ),
    );
  });
  await settle();
  return container;
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
    // store 复位也放在 act 里：外部 store 的写入同样会触发 React 的"未包裹更新"警告。
    useMusicStore.setState({
      view: "generate",
      playlistId: null,
      focusRecordId: null,
      queueOpen: false,
      nowPlaying: false,
    });
    playerStore.setState({
      queue: [],
      index: -1,
      playing: false,
      error: null,
      source: null,
      currentTime: 0,
      duration: 0,
      repeat: "list",
    });
  });
  container?.remove();
  calls.length = 0;
});

function track(over: Partial<TrackRow> & { id: number }): TrackRow {
  return {
    title: `作品 ${over.id}`,
    status: "done",
    audioUrl: `http://127.0.0.1:1/images/music/${over.id}.mp3`,
    durationMs: 180_000,
    lyrics: null,
    rewrittenLyrics: null,
    instrumental: false,
    task: "text_to_music",
    source: "manual",
    caption: "城市夜景 City Pop",
    model: "stepfun-music",
    createdAt: Date.now(),
    ...over,
  };
}

beforeEach(() => {
  playlists = [
    {
      id: 1,
      name: "默认歌单",
      builtin: true,
      count: 3,
      coverSeeds: [{ id: 11, title: "A" }, { id: 12, title: "B" }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    {
      id: 2,
      name: "深夜 City Pop",
      builtin: false,
      count: 1,
      coverSeeds: [{ id: 11, title: "A" }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ];
  tracks = [
    track({ id: 11, title: "秋天的银杏大道" }),
    track({ id: 12, title: "雪落下的声音", status: "processing", audioUrl: null }),
    track({ id: 13, title: "海边的信号灯", status: "failed", audioUrl: null }),
  ];
});

// ---------------------------------------------------------------------------
// 侧栏
// ---------------------------------------------------------------------------

test("侧栏：默认歌单不给改名 / 删除，自建歌单两个按钮都在", async () => {
  await render(createElement(MusicPlaylistSidebar));

  expect(container.textContent).toContain(zh("music.playlist.default"));
  expect(container.textContent).toContain("深夜 City Pop");
  // 数量来自后端摘要（不是本地数出来的）。
  expect(container.textContent).toContain(zh("music.playlist.songCount", { n: "3" }));

  const rename = container.querySelectorAll(`[aria-label="${zh("music.playlist.rename")}"]`);
  const remove = container.querySelectorAll(`[aria-label="${zh("music.playlist.delete")}"]`);
  expect(rename.length).toBe(1);
  expect(remove.length).toBe(1);
});

test("侧栏：新建歌单 → 调 createMusicPlaylist 并直接切进新歌单", async () => {
  await render(createElement(MusicPlaylistSidebar));

  const newButton = container.querySelector<HTMLElement>(
    `[aria-label="${zh("music.playlist.new")}"]`,
  );
  await act(async () => {
    newButton!.click();
  });

  const input = document.querySelector<HTMLInputElement>("#music-playlist-name");
  expect(input).not.toBeNull();
  await act(async () => {
    // React 受控输入：走原生 setter 再派发 input 事件。
    const setter = Object.getOwnPropertyDescriptor(
      (dom as unknown as { HTMLInputElement: { prototype: object } }).HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, "雨夜读书");
    input!.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });

  const confirm = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === zh("music.playlist.create"),
  )!;
  await act(async () => {
    confirm.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(calls.find((c) => c.method === "createMusicPlaylist")?.params).toEqual({ name: "雨夜读书" });
  // 建完直接进去：不该让用户再点一次才看到新歌单。
  expect(useMusicStore.getState().view).toBe("playlist");
  expect(useMusicStore.getState().playlistId).toBe(100);
});

test("侧栏：删除歌单先弹确认框，确认后才动手", async () => {
  await render(createElement(MusicPlaylistSidebar));
  // 侧栏订阅着 view / playlistId，这一笔也要写在 act 里。
  await act(async () => {
    useMusicStore.setState({ view: "playlist", playlistId: 2 });
  });

  const remove = container.querySelector<HTMLElement>(
    `[aria-label="${zh("music.playlist.delete")}"]`,
  );
  await act(async () => {
    remove!.click();
  });

  expect(document.body.textContent).toContain(
    zh("music.playlist.deleteTitle", { name: "深夜 City Pop" }),
  );
  expect(calls.some((c) => c.method === "deleteMusicPlaylist")).toBe(false);

  const confirm = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === zh("common.delete"),
  )!;
  // 删除的 onSuccess 里还有一次 setState（退回创作页），要等 mutation 的 promise 落地 ——
  // 只 await 微任务会让那次更新跑到 act 外面去（React 会警告）。
  await act(async () => {
    confirm.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(calls.find((c) => c.method === "deleteMusicPlaylist")?.params).toEqual({ id: 2 });
  // 删掉的正是当前打开的那个：退回创作页，右侧不会停在已不存在的歌单上。
  expect(useMusicStore.getState().view).toBe("generate");
});

// ---------------------------------------------------------------------------
// 曲目页
// ---------------------------------------------------------------------------

test("曲目页：列出全部曲目（含生成中 / 失败），并标注不可播放", async () => {
  await render(createElement(PlaylistView, { playlistId: 1 }));

  expect(container.textContent).toContain("秋天的银杏大道");
  expect(container.textContent).toContain("雪落下的声音");
  expect(container.textContent).toContain("海边的信号灯");
  expect(container.textContent).toContain(zh("music.status.failed"));
  expect(container.textContent).toContain(zh("music.playlist.songCount", { n: "3" }));
});

test("曲目页：点一行 = 整个歌单成为队列，从这首开始播", async () => {
  await render(createElement(PlaylistView, { playlistId: 1 }));

  const row = container.querySelector<HTMLElement>('[aria-label="秋天的银杏大道"]')!;
  await act(async () => {
    row.click();
  });

  const state = useMusicPlayer.getState();
  expect(state.queue.map((r) => r.id)).toEqual([11, 12, 13]);
  expect(state.index).toBe(0);
  expect(state.source).toEqual({ playlistId: 1, name: zh("music.playlist.default") });
});

test("曲目页：生成中的曲目点不动，但留在队列里", async () => {
  await render(createElement(PlaylistView, { playlistId: 1 }));

  const processing = container.querySelector<HTMLElement>('[aria-label="雪落下的声音"]')!;
  await act(async () => {
    processing.click();
  });
  // 没开始播任何东西，也不该"退而求其次"播别的。
  expect(useMusicPlayer.getState().index).toBe(-1);

  // 从头播整个歌单：不可播的第 2 首被跳过，但队列里仍然有它。
  const row = container.querySelector<HTMLElement>('[aria-label="秋天的银杏大道"]')!;
  await act(async () => {
    row.click();
  });
  expect(useMusicPlayer.getState().queue.length).toBe(3);
  expect(useMusicPlayer.getState().queue[1]!.status).toBe("processing");
});

test("曲目页：行内菜单能把作品移出歌单", async () => {
  await render(createElement(PlaylistView, { playlistId: 1 }));

  const more = container.querySelector<HTMLElement>(`[aria-label="${zh("music.track.more")}"]`)!;
  await act(async () => {
    more.click();
    await Promise.resolve();
  });

  // Radix 的浮层挂在 document.body 上，不在被测容器里。
  const item = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === zh("music.track.removeFromPlaylist"),
  )!;
  await act(async () => {
    item.click();
    await Promise.resolve();
  });

  expect(calls.find((c) => c.method === "removeMusicFromPlaylist")?.params).toEqual({
    playlistId: 1,
    recordId: 11,
  });
});

// ---------------------------------------------------------------------------
// 播放器 store：队列 / 上下首 / 循环 / 错队列
// ---------------------------------------------------------------------------

const row = (id: number, playable = true) =>
  track({ id, status: playable ? "done" : "processing", audioUrl: playable ? `http://x/${id}.mp3` : null });

test("队列：列表循环绕回，上一首从头绕到末尾", () => {
  const store = useMusicPlayer.getState();
  const records = [row(1), row(2), row(3)] as never[];
  store.playQueue(records, 3, null);
  expect(useMusicPlayer.getState().index).toBe(2);

  useMusicPlayer.getState().next(false);
  expect(useMusicPlayer.getState().index).toBe(0);
  useMusicPlayer.getState().prev();
  expect(useMusicPlayer.getState().index).toBe(2);
});

test("队列：单曲循环只在自动续播时重播，手动下一首仍然换歌", () => {
  const records = [row(1), row(2)] as never[];
  useMusicPlayer.getState().playQueue(records, 1, null);
  useMusicPlayer.setState({ repeat: "single" });

  useMusicPlayer.getState().next(true);
  expect(useMusicPlayer.getState().index).toBe(0);

  useMusicPlayer.getState().next(false);
  expect(useMusicPlayer.getState().index).toBe(1);
});

test("队列：不可播的曲目被跳过，整队都不可播时给出可读错误", () => {
  const mixed = [row(1, false), row(2, false), row(3)] as never[];
  useMusicPlayer.getState().playQueue(mixed, 1, null);
  // 从第 2 首（生成中）往后找到第一首可播的。
  expect(useMusicPlayer.getState().index).toBe(2);
  expect(useMusicPlayer.getState().queue.length).toBe(3);

  const dead = [row(4, false), row(5, false)] as never[];
  useMusicPlayer.getState().playQueue(dead, 4, null);
  expect(useMusicPlayer.getState().index).toBe(-1);
  expect(useMusicPlayer.getState().error).toBe("music.play.empty");
});

test("队列：删掉正在播的那首 = 换到下一首，其余下标跟着收敛", () => {
  const records = [row(1), row(2), row(3)] as never[];
  // playQueue 的第二个参数是曲目 id（不是下标）：id 2 落在下标 1。
  useMusicPlayer.getState().playQueue(records, 2, null);
  expect(useMusicPlayer.getState().index).toBe(1);
  useMusicPlayer.getState().removeFromQueue(1);
  const state = useMusicPlayer.getState();
  expect(state.queue.map((r) => r.id)).toEqual([1, 3]);
  // 删的是正在播的那首：当前曲目顺延到原来排在它后面的那一首。
  expect(state.queue[state.index]!.id).toBe(3);
});

test("队列：列表刷新后回填字段，生成中的作品拿到音频即可播", () => {
  const records = [row(1, false)] as never[];
  useMusicPlayer.getState().playQueue(records, 1, null);
  expect(useMusicPlayer.getState().error).toBe("music.play.empty");

  const finished = row(1);
  useMusicPlayer.getState().patchQueue([finished] as never[]);
  expect(useMusicPlayer.getState().queue[0]!.audioUrl).toBe("http://x/1.mp3");
  // 回填只改数据，不会自己开始播（播放仍要用户点一次）。
  expect(useMusicPlayer.getState().index).toBe(-1);
});

test("循环模式：列表 → 单曲 → 随机 → 列表", () => {
  const store = useMusicPlayer.getState();
  expect(useMusicPlayer.getState().repeat).toBe("list");
  store.cycleRepeat();
  expect(useMusicPlayer.getState().repeat).toBe("single");
  store.cycleRepeat();
  expect(useMusicPlayer.getState().repeat).toBe("shuffle");
  store.cycleRepeat();
  expect(useMusicPlayer.getState().repeat).toBe("list");
});

test("播放条：没有队列时显示占位而不是隐藏控件", async () => {
  await render(createElement(MusicPlayerBar));
  expect(container.textContent).toContain(zh("music.player.noTrack"));
  const prev = container.querySelector<HTMLButtonElement>(
    `[aria-label="${zh("music.player.prev")}"]`,
  )!;
  expect(prev.disabled).toBe(true);
});

test("歌词：空行丢掉，`[Verse]` / `【主歌】` 标成段落标题而不是正文", () => {
  const lines = parseLyrics("[Verse 1]\n\n海边的信号灯\n  亮了三下  \n【副歌】\n你还在等谁");
  expect(lines.map((l) => l.text)).toEqual([
    "[Verse 1]",
    "海边的信号灯",
    "亮了三下",
    "【副歌】",
    "你还在等谁",
  ]);
  // 只有后两行之外的正文才算"内容行"：段落标题不参与高亮计数。
  expect(lines.filter((l) => !l.tag).length).toBe(3);
});

test("歌词清洗：上游塞进来的 markdown 记号被剥掉，标题行不被当歌词", () => {
  // 真实拿到过的形状（StepFun 返回的《纸鸢误》）。
  const lines = parseLyrics("## 《纸鸢误》\n**【主歌一】**\n宣纸铺开三月的柳烟\n**自带强调的行**");
  expect(lines.map((l) => l.text)).toEqual([
    "《纸鸢误》",
    "【主歌一】",
    "宣纸铺开三月的柳烟",
    // 整行加粗的"装饰"也一并剥掉（显示层不该出现星号），但它仍然是正文行。
    "自带强调的行",
  ]);
  expect(lines.map((l) => l.tag)).toEqual([true, true, false, false]);
});

test("队列：删空最后一首后不停在「还在放但没有队列」的状态", () => {
  const records = [row(1)] as never[];
  useMusicPlayer.getState().playQueue(records, 1, null);
  useMusicPlayer.getState().removeFromQueue(0);
  const state = useMusicPlayer.getState();
  expect(state.queue).toEqual([]);
  expect(state.index).toBe(-1);
  expect(state.playing).toBe(false);
  expect(state.currentTime).toBe(0);
});

// ---------------------------------------------------------------------------
// 单曲播放页（左转盘 + 右歌词）
// ---------------------------------------------------------------------------

const { NowPlayingView } = await import("./now-playing");

/** 造一首带歌词的当前曲目。 */
function seedNowPlaying(lyrics: string, playing = false) {
  const record = track({ id: 11, title: "秋天的银杏大道", lyrics, rewrittenLyrics: lyrics });
  useMusicPlayer.setState({
    queue: [record as never],
    index: 0,
    playing,
    duration: 180,
    currentTime: 0,
    source: { playlistId: 1, name: "默认歌单" },
    error: null,
  });
  return record;
}

test("播放条：点封面 / 转盘按钮打开单曲播放页，开队列时播放页让位", async () => {
  await render(createElement(MusicPlayerBar));

  const open = container.querySelector<HTMLElement>(`[aria-label="${zh("music.now.open")}"]`)!;
  await act(async () => {
    open.click();
  });
  expect(useMusicStore.getState().nowPlaying).toBe(true);
  expect(useMusicStore.getState().queueOpen).toBe(false);

  // 两个浮层互斥：打开队列就把播放页收起来（同时开着会把主区挤成一条缝）。
  await act(async () => {
    useMusicStore.setState({ nowPlaying: true });
    useMusicStore.getState().toggleQueue();
  });
  expect(useMusicStore.getState().queueOpen).toBe(true);
  expect(useMusicStore.getState().nowPlaying).toBe(false);
});

test("单曲播放页：左侧转盘 + 右侧歌词，暂停时转盘停住", async () => {
  seedNowPlaying("[Verse 1]\n海边的信号灯\n亮了三下");
  await render(createElement(NowPlayingView));

  // 转盘在，且暂停时是"停住"而不是不渲染（data-paused 决定 animation-play-state）。
  const disc = container.querySelector<HTMLElement>(".music-disc");
  expect(disc).not.toBeNull();
  expect(disc!.dataset.paused).toBe("true");

  // 歌词：结构标签不参与高亮，内容行原样显示。
  expect(container.textContent).toContain("海边的信号灯");
  expect(container.textContent).toContain("亮了三下");
  expect(container.textContent).toContain("[Verse 1]");

  await act(async () => {
    useMusicPlayer.setState({ playing: true });
  });
  expect(container.querySelector<HTMLElement>(".music-disc")!.dataset.paused).toBe("false");
});

test("单曲播放页：点歌词跳到估算位置，收起按钮关掉它", async () => {
  seedNowPlaying("[Intro]\n第一句\n第二句\n第三句\n第四句");

  // seek 的替身要在 render 之前装好：组件在渲染时就把动作取出来了（引用稳定，
  // 组件里不必每次渲染都重新取一遍）—— 渲染之后再换就换不进去了。
  const original = useMusicPlayer.getState().seek;
  const sought: number[] = [];
  useMusicPlayer.setState({ seek: (s: number) => sought.push(s) });
  try {
    await render(createElement(NowPlayingView));

    const line = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "第三句",
    )!;
    await act(async () => {
      line.click();
    });
    // 5 行里 4 行内容、总时长 180s → 第三句（内容行下标 2）落在 2/4 * 180 = 90s。
    expect(sought).toEqual([90]);
  } finally {
    useMusicPlayer.setState({ seek: original });
  }

  await act(async () => {
    container.querySelector<HTMLElement>(`[aria-label="${zh("music.now.collapse")}"]`)!.click();
  });
  expect(useMusicStore.getState().nowPlaying).toBe(false);
});

test("单曲播放页：纯器乐没有歌词时给出说明而不是空白", async () => {
  const record = seedNowPlaying("");
  useMusicPlayer.setState({ queue: [{ ...record, instrumental: true } as never] });
  await render(createElement(NowPlayingView));
  expect(container.textContent).toContain(zh("music.lyrics.instrumental"));
});

test("歌词时间估算：时长未知时不跳转，越界不给值", () => {
  expect(estimatedLineTime(0, 4, 180)).toBe(0);
  expect(estimatedLineTime(2, 4, 180)).toBe(90);
  expect(estimatedLineTime(2, 4, 0)).toBeNull();
  expect(estimatedLineTime(4, 4, 180)).toBeNull();
  expect(estimatedLineTime(-1, 4, 180)).toBeNull();
  expect(estimatedLineTime(0, 0, 180)).toBeNull();
});


test("歌词：有对齐结果时用真时间轴（不是均分估算）", () => {
  const lrc = parseLrc("[00:12.50]第一句\n[00:31.00]第二句\n[01:02.25]第三句");
  expect(lrc.map((l) => l.time)).toEqual([12.5, 31, 62.25]);
  // 二分找当前行：12.5 之前没有、12.5~31 之间是第一句。
  expect(currentLrcIndex(lrc, 0)).toBe(-1);
  expect(currentLrcIndex(lrc, 12.4)).toBe(-1);
  expect(currentLrcIndex(lrc, 12.5)).toBe(0);
  expect(currentLrcIndex(lrc, 40)).toBe(1);
  expect(currentLrcIndex(lrc, 999)).toBe(2);
});


// ---------------------------------------------------------------------------
// 作品封面（一键生成 / 本地上传 / 换回渐变）
// ---------------------------------------------------------------------------

const { MusicCover, PlaylistCover } = await import("./cover");
const { CoverMenu } = await import("./cover-menu");

test("封面：有真封面就贴图，没有才画渐变（不是两层都画）", async () => {
  await render(
    createElement(
      "div",
      null,
      createElement(MusicCover, { seed: "1", label: "纸鸢误", src: "http://x/c.webp" }),
      createElement(MusicCover, { seed: "2", label: "没有封面" }),
    ),
  );
  const imgs = container.querySelectorAll("img");
  expect(imgs.length).toBe(1);
  expect(imgs[0]!.getAttribute("src")).toBe("http://x/c.webp");
  // 没有封面那张：用首字当水印，而不是空着。
  expect(container.textContent).toContain("没");
});

test("歌单拼图：四格各取自己的真封面，缺的那个退回渐变", async () => {
  await render(
    createElement(PlaylistCover, {
      seeds: [
        { id: 1, title: "甲", coverUrl: "http://x/1.webp" },
        { id: 2, title: "乙", coverUrl: null },
      ],
    }),
  );
  expect(container.querySelectorAll("img").length).toBe(1);
  expect(container.textContent).toContain("乙");
});

test("换封面菜单：生成 / 上传各走各的 RPC，且点完不自动关（要留着看进度和报错）", async () => {
  await render(createElement(CoverMenu, { recordId: 11, hasCover: false }));

  await act(async () => {
    container.querySelector<HTMLElement>(`[aria-label="${zh("music.cover.change")}"]`)!.click();
    await Promise.resolve();
  });
  const menuItem = (label: string) =>
    Array.from(document.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").trim().startsWith(label),
    )!;

  await act(async () => {
    menuItem(zh("music.cover.generate")).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(calls.find((c) => c.method === "generateMusicCover")?.params).toEqual({ id: 11 });
  // 还在开着：生成要等几十秒，关掉就看不到进度了。
  expect(menuItem(zh("music.cover.generate"))).toBeTruthy();

  await act(async () => {
    menuItem(zh("music.cover.upload")).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  // 上传要走文件框 → 把选中的路径交给主进程（裁方图在主进程做）。
  expect(calls.find((c) => c.method === "setMusicCover")?.params).toEqual({
    id: 11,
    path: "/tmp/pick.png",
  });
});

test("换封面菜单：「换回渐变」只在已经有真封面时出现", async () => {
  const openMenu = async () => {
    await act(async () => {
      container.querySelector<HTMLElement>(`[aria-label="${zh("music.cover.change")}"]`)!.click();
      await Promise.resolve();
    });
    return Array.from(document.querySelectorAll("button")).map((b) => b.textContent ?? "");
  };

  await render(createElement(CoverMenu, { recordId: 11, hasCover: false }));
  const without = await openMenu();
  // 先确认菜单真的开了（否则"没有换回渐变"这条断言等于没断言）。
  expect(without.some((l) => l.includes(zh("music.cover.generate")))).toBe(true);
  expect(without.some((l) => l.includes(zh("music.cover.reset")))).toBe(false);

  await render(createElement(CoverMenu, { recordId: 11, hasCover: true }));
  const withCover = await openMenu();
  const resetItem = Array.from(document.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes(zh("music.cover.reset")),
  )!;
  expect(withCover.some((l) => l.includes(zh("music.cover.reset")))).toBe(true);

  await act(async () => {
    resetItem.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(calls.find((c) => c.method === "clearMusicCover")?.params).toEqual({ id: 11 });
});
