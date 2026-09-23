import { create } from "zustand";

/** 音乐页内部视图：创作参数页 / 某个歌单的曲目页 / 全部作品网格页。 */
export type MusicView = "generate" | "playlist" | "history";

interface MusicState {
  /** 当前视图。 */
  view: MusicView;
  setView: (view: MusicView) => void;
  /** 当前打开的歌单（view === "playlist" 时有效）。 */
  playlistId: number | null;
  setPlaylistId: (id: number | null) => void;
  /** 打开某个歌单：侧栏点击的唯一入口 —— 视图与歌单一起切，不会出现"切了视图没切歌单"。 */
  openPlaylist: (id: number) => void;
  /** 当前聚焦展示的记录（创作页右侧 / 最近条点击 / 刚要提交的任务）。 */
  focusRecordId: number | null;
  setFocusRecordId: (id: number | null) => void;
  /** 右侧的播放队列抽屉。 */
  queueOpen: boolean;
  toggleQueue: () => void;
  setQueueOpen: (open: boolean) => void;
  /**
   * 单曲播放页（左侧黑胶转盘 + 右侧滚动歌词），盖在主区之上。
   *
   * 和队列抽屉**互斥**：两个都是"看当前这首"的浮层，同时开着会把主区挤成一条缝。
   * 打开一个就关掉另一个（网易云里也是这样一层一层退出去的）。
   */
  nowPlaying: boolean;
  openNowPlaying: () => void;
  closeNowPlaying: () => void;
  toggleNowPlaying: () => void;
}

export const useMusicStore = create<MusicState>((set, get) => ({
  view: "generate",
  setView: (view) => set({ view }),
  playlistId: null,
  setPlaylistId: (playlistId) => set({ playlistId }),
  openPlaylist: (playlistId) => set({ playlistId, view: "playlist" }),
  focusRecordId: null,
  setFocusRecordId: (focusRecordId) => set({ focusRecordId }),
  queueOpen: false,
  toggleQueue: () => set({ queueOpen: !get().queueOpen, nowPlaying: false }),
  setQueueOpen: (queueOpen) => set({ queueOpen, ...(queueOpen ? { nowPlaying: false } : {}) }),
  nowPlaying: false,
  openNowPlaying: () => set({ nowPlaying: true, queueOpen: false }),
  closeNowPlaying: () => set({ nowPlaying: false }),
  toggleNowPlaying: () =>
    set(get().nowPlaying ? { nowPlaying: false } : { nowPlaying: true, queueOpen: false }),
}));
