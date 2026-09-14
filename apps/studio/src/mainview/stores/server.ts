import { create } from "zustand";
import type { ServerStatus } from "../../bun/server-manager";
import type { MediaServerStatus } from "../../bun/image-server";

interface ServerState {
  status: ServerStatus;
  /**
   * 媒体服务状态（聊天图片 / 生成图 / OCR 页图 / TTS 音频都由主进程这个本地 HTTP 服务提供）。
   * 端口被另一个数据目录的实例占着时是 `blocked`，顶栏要如实提示。
   */
  mediaStatus: MediaServerStatus;
  logs: string;
  setStatus: (status: ServerStatus) => void;
  setMediaStatus: (status: MediaServerStatus) => void;
  appendLog: (text: string) => void;
  clearLogs: () => void;
  setLogs: (logs: string) => void;
}

const MAX_LOG_CHARS = 100_000;
const FLUSH_INTERVAL_MS = 80;

let pendingChunks: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flushPending() {
  flushTimer = null;
  if (pendingChunks.length === 0) return;
  const batch = pendingChunks.join("");
  pendingChunks = [];
  useServerStore.getState().commitLog(batch);
}

function scheduleFlush() {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(flushPending, FLUSH_INTERVAL_MS);
}

export const useServerStore = create<
  ServerState & { commitLog: (text: string) => void }
>((set) => ({
  status: "stopped",
  mediaStatus: { state: "serving" },
  logs: "",
  setStatus: (status) => set({ status }),
  setMediaStatus: (mediaStatus) => set({ mediaStatus }),
  appendLog: (text) => {
    pendingChunks.push(text);
    scheduleFlush();
  },
  commitLog: (text) =>
    set((state) => {
      let next = state.logs + text;
      if (next.length > MAX_LOG_CHARS) next = next.slice(-MAX_LOG_CHARS);
      return { logs: next };
    }),
  clearLogs: () => {
    pendingChunks = [];
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    set({ logs: "" });
  },
  setLogs: (logs) => set({ logs }),
}));
