/**
 * 音乐播放器：队列、上下首、循环模式、进度、音量。
 *
 * 三件事决定了这里的写法：
 *
 * 1. **音频元素是模块级单例，不进 React 树**。播放不能因为组件卸载而中断
 *    （切到创作页 / 历史页、播放条重渲染都不该重启音频），所以 `<audio>` 不放 JSX，
 *    由 `ensureAudio()` 懒建一次，事件回调直接写 zustand。
 * 2. **队列是"快照 + 补丁"**。点歌单时把当时的曲目列表整份抄进队列（顺序、来源都跟着走），
 *    之后由 `patchQueue()` 在列表数据刷新时回填字段 —— 生成中的作品拿到音频后，
 *    队列里那一份也要跟着能播，否则"点了播放没反应"。
 * 3. **不可播放的曲目不参与播放但留在队列里**：生成中 / 失败的歌在歌单里看得见，
 *    跳下一首时自动跳过它们；整队都不可播时停下并给一条可见的错误，不做成静默无反应。
 */
import { create } from "zustand";

import type { MusicRecordRow } from "../../bun/music-gen";
import { useMusicStore } from "./music";

/** 播放模式：列表循环 / 单曲循环 / 随机。 */
export type MusicRepeatMode = "list" | "single" | "shuffle";

/** 队列来源：底部播放条显示"播放队列 · 歌单名"。 */
export interface MusicQueueSource {
  playlistId: number;
  name: string;
}

const VOLUME_KEY = "omni.music.volume";
const REPEAT_KEY = "omni.music.repeat";

/** 记一个偏好到 localStorage：隐私模式下会抛错，当次会话仍然生效（与 stores/agent 同策略）。 */
function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* 无 localStorage：只用当次会话 */
  }
}

function initialVolume(): number {
  const raw = Number(readPref(VOLUME_KEY));
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.8;
}

function initialRepeat(): MusicRepeatMode {
  const raw = readPref(REPEAT_KEY);
  return raw === "single" || raw === "shuffle" || raw === "list" ? raw : "list";
}

interface MusicPlayerState {
  /** 当前播放队列（点歌单 / 点单曲时快照下来的那份顺序）。 */
  queue: MusicRecordRow[];
  /** 当前曲目在队列中的下标；-1 = 还没有选中任何曲目。 */
  index: number;
  playing: boolean;
  repeat: MusicRepeatMode;
  /** 0~1。 */
  volume: number;
  muted: boolean;
  /** 播放进度（秒）与总时长（秒）；时长未知时为 0。 */
  currentTime: number;
  duration: number;
  /** 队列来源歌单；从创作结果卡直接播单曲时为 null。 */
  source: MusicQueueSource | null;
  /** 上一条播放错误（加载失败 / 整队不可播），播放条上原样显示。 */
  error: string | null;

  /** 用一份曲目列表开始播放；`recordId` 指定从哪一首开始（缺省从头）。 */
  playQueue: (records: MusicRecordRow[], recordId: number | null, source: MusicQueueSource | null) => void;
  /** 播放/暂停切换；还没选曲目时从队列第一首可播的开始。 */
  toggle: () => void;
  /** 下一首。`auto` 表示由播放结束自动触发（单曲循环只在自动时重播）。 */
  next: (auto?: boolean) => void;
  prev: () => void;
  /** 跳到队列里的某一首（点击队列 / 曲目行）。 */
  jumpTo: (index: number) => void;
  seek: (seconds: number) => void;
  setVolume: (volume: number) => void;
  toggleMute: () => void;
  cycleRepeat: () => void;
  /** 从队列里移除一首（队列面板上的 ×）。 */
  removeFromQueue: (index: number) => void;
  clearQueue: () => void;
  /** 列表数据刷新后回填队列里的记录字段（生成中的作品拿到音频后可播）。 */
  patchQueue: (records: MusicRecordRow[]) => void;
}

/** 可播放 = 有成品音频。生成中 / 失败的曲目在歌单里保留，但不参与播放。 */
export function isPlayable(record: MusicRecordRow | undefined): record is MusicRecordRow {
  return !!record && record.status === "done" && !!record.audioUrl;
}

// ---------------------------------------------------------------------------
// 音频元素（模块级单例）
// ---------------------------------------------------------------------------

let audio: HTMLAudioElement | null = null;
/** 连续失败计数：整队都播不了时用来收手，避免在坏队列上无限跳。 */
let failureRun = 0;

function ensureAudio(): HTMLAudioElement | null {
  if (audio) return audio;
  if (typeof window === "undefined" || typeof window.Audio !== "function") return null;
  const el = new window.Audio();
  el.preload = "metadata";
  el.volume = useMusicPlayer.getState().volume;
  el.muted = useMusicPlayer.getState().muted;

  el.addEventListener("timeupdate", () => {
    useMusicPlayer.setState({ currentTime: el.currentTime });
  });
  const syncDuration = () => {
    // 流式 mp3 的 duration 可能是 Infinity/NaN，界面按"未知"处理。
    const d = el.duration;
    useMusicPlayer.setState({ duration: Number.isFinite(d) && d > 0 ? d : 0 });
  };
  el.addEventListener("durationchange", syncDuration);
  el.addEventListener("loadedmetadata", syncDuration);
  el.addEventListener("play", () => useMusicPlayer.setState({ playing: true }));
  el.addEventListener("pause", () => useMusicPlayer.setState({ playing: false }));
  el.addEventListener("ended", () => useMusicPlayer.getState().next(true));
  el.addEventListener("error", () => {
    const state = useMusicPlayer.getState();
    failureRun += 1;
    // 整队都放不出来（文件被删 / 服务未起 / 全是空队列）就停在原地并说明原因，
    // 不要一边报错一边把队列从头跳到尾。
    if (failureRun > state.queue.length) {
      failureRun = 0;
      useMusicPlayer.setState({ playing: false, error: "music.play.errorAll" });
      return;
    }
    if (state.queue.length > 1) {
      state.next(true);
    } else {
      useMusicPlayer.setState({ playing: false, error: "music.play.error" });
    }
  });
  audio = el;
  return el;
}

/**
 * 起播。自动播放可能被策略拒绝、`play()` 在个别引擎/测试环境里也可能不返回 Promise ——
 * 两种情况都只把 playing 落回 false，让用户再点一次（那就是手势触发的了）。
 */
function startPlayback(el: HTMLAudioElement): void {
  try {
    failureRun = 0;
    const started = el.play();
    if (started && typeof started.then === "function") {
      started.catch(() => useMusicPlayer.setState({ playing: false }));
    }
  } catch {
    useMusicPlayer.setState({ playing: false });
  }
}

/** 装载并播放队列中的第 i 首。返回是否真的开始播（不可播则不动状态）。 */
function load(index: number, mode: "play" | "load" = "play"): boolean {
  const { queue } = useMusicPlayer.getState();
  const record = queue[index];
  if (index < 0 || !isPlayable(record)) return false;
  const el = ensureAudio();
  useMusicPlayer.setState({
    index,
    error: null,
    currentTime: 0,
    duration: record.durationMs ? record.durationMs / 1000 : 0,
  });
  if (!el) return false;
  if (el.dataset.recordId !== String(record.id)) {
    el.src = record.audioUrl!;
    el.dataset.recordId = String(record.id);
  }
  el.volume = useMusicPlayer.getState().volume;
  el.muted = useMusicPlayer.getState().muted;
  if (mode === "play") startPlayback(el);
  return true;
}

/** 从 `from` 起（含）找第一首可播放的，找不到返回 -1；`wrap` 决定是否绕回开头。 */
function findPlayable(from: number, wrap: boolean): number {
  const { queue } = useMusicPlayer.getState();
  if (queue.length === 0) return -1;
  const start = wrap ? ((from % queue.length) + queue.length) % queue.length : Math.max(0, from);
  for (let step = 0; step < queue.length; step += 1) {
    const i = wrap ? (start + step) % queue.length : start + step;
    if (i >= queue.length) break;
    if (isPlayable(queue[i])) return i;
  }
  return -1;
}

export const useMusicPlayer = create<MusicPlayerState>((set, get) => ({
  queue: [],
  index: -1,
  playing: false,
  repeat: initialRepeat(),
  volume: initialVolume(),
  muted: false,
  currentTime: 0,
  duration: 0,
  source: null,
  error: null,

  playQueue: (records, recordId, source) => {
    const queue = records.slice();
    set({ queue, source, error: null });
    // 「点播放」= 想听这首：直接进单曲播放页（网易云的默认行为）。
    // 只在这一处做：上/下一首与自动续播不动这个开关 —— 用户手动收起播放页之后，
    // 按一下"下一首"又弹回来是最烦人的那种"贴心"。
    useMusicStore.setState({ nowPlaying: true, queueOpen: false });
    // 调用方负责把"要播的那一首"放进 records（列表页自然是这样）；
    // 找不到时退回列表头，不让 recordId 变成静默的"什么都不播"。
    const found = recordId == null ? 0 : queue.findIndex((r) => r.id === recordId);
    const wanted = found < 0 ? 0 : found;
    const at = findPlayable(wanted, true);
    if (at < 0) {
      set({ index: -1, playing: false, error: "music.play.empty" });
      return;
    }
    load(at);
  },

  toggle: () => {
    const { index, playing } = get();
    if (index < 0 || !isPlayable(get().queue[index])) {
      const at = findPlayable(0, true);
      if (at < 0) {
        set({ error: "music.play.empty" });
        return;
      }
      load(at);
      return;
    }
    const el = ensureAudio();
    if (!el) {
      set({ playing: !playing });
      return;
    }
    if (el.paused) {
      startPlayback(el);
    } else {
      el.pause();
    }
  },

  next: (auto = false) => {
    const state = get();
    const { queue, index, repeat } = state;
    if (queue.length === 0) return;

    // 单曲循环只在"自动续播"时重播当前这首；手动点下一首仍然换歌（与主流播放器一致）。
    if (auto && repeat === "single" && index >= 0 && isPlayable(queue[index])) {
      const el = ensureAudio();
      if (el) {
        el.currentTime = 0;
        startPlayback(el);
        return;
      }
    }

    if (repeat === "shuffle" && queue.length > 1) {
      const playable = queue.map((r, i) => (isPlayable(r) ? i : -1)).filter((i) => i >= 0);
      const others = playable.filter((i) => i !== index);
      const pool = others.length > 0 ? others : playable;
      if (pool.length > 0) {
        load(pool[Math.floor(Math.random() * pool.length)]!);
        return;
      }
    }

    const at = findPlayable(index + 1, true);
    if (at < 0) {
      set({ playing: false, error: "music.play.empty" });
      return;
    }
    load(at);
  },

  prev: () => {
    const { queue, index } = get();
    if (queue.length === 0) return;
    const at = findPlayable(index - 1, true);
    if (at < 0) {
      set({ playing: false, error: "music.play.empty" });
      return;
    }
    load(at);
  },

  jumpTo: (index) => {
    if (!load(index)) {
      // 生成中 / 失败的曲目点了不播 —— 让行自己显示状态，这里的静默是刻意的。
      return;
    }
  },

  seek: (seconds) => {
    const el = ensureAudio();
    if (!el) return;
    try {
      el.currentTime = Math.max(0, seconds);
      set({ currentTime: el.currentTime });
    } catch {
      /* 元数据还没到时 set 会抛，忽略 */
    }
  },

  setVolume: (volume) => {
    const v = Math.min(1, Math.max(0, volume));
    const el = ensureAudio();
    if (el) {
      el.volume = v;
      // 拖音量条本身就意味着要出声，顺手取消静音（与系统播放器一致）。
      if (v > 0 && el.muted) {
        el.muted = false;
        set({ muted: false });
      }
    }
    writePref(VOLUME_KEY, String(v));
    set({ volume: v });
  },

  toggleMute: () => {
    const muted = !get().muted;
    const el = ensureAudio();
    if (el) el.muted = muted;
    set({ muted });
  },

  cycleRepeat: () => {
    const order: MusicRepeatMode[] = ["list", "single", "shuffle"];
    const next = order[(order.indexOf(get().repeat) + 1) % order.length]!;
    writePref(REPEAT_KEY, next);
    set({ repeat: next });
  },

  removeFromQueue: (index) => {
    const { queue, index: current } = get();
    if (index < 0 || index >= queue.length) return;
    const nextQueue = queue.filter((_, i) => i !== index);
    if (index === current) {
      // 删的正是当前播放的那首：换成它后面那首（删一首就等于"下一首"）。
      set({ queue: nextQueue, index: -1 });
      const at = findPlayable(index, true);
      if (at < 0) {
        // 队列里已经没有可播的了：音频也要停下来，否则会一边放着一边显示"队列是空的"。
        const el = ensureAudio();
        if (el) {
          el.pause();
          el.removeAttribute("src");
          delete el.dataset.recordId;
        }
        set({ playing: false, index: -1, error: null, currentTime: 0, duration: 0 });
      } else {
        load(at);
      }
      return;
    }
    set({ queue: nextQueue, index: index < current ? current - 1 : current });
  },

  clearQueue: () => {
    const el = ensureAudio();
    if (el) {
      el.pause();
      el.removeAttribute("src");
      delete el.dataset.recordId;
    }
    set({
      queue: [],
      index: -1,
      playing: false,
      currentTime: 0,
      duration: 0,
      source: null,
      error: null,
    });
  },

  patchQueue: (records) => {
    const { queue } = get();
    if (queue.length === 0) return;
    const byId = new Map(records.map((r) => [r.id, r]));
    let changed = false;
    const nextQueue = queue.map((r) => {
      const fresh = byId.get(r.id);
      if (!fresh || fresh === r) return r;
      // 只关心会影响播放 / 播放页显示的字段，避免每 5 秒轮询都换掉整队引用
      // （换引用 = 重渲染整条播放条）。歌词与对齐结果必须算进来：一键对齐完成后
      // 队列里那份还是旧的，播放页就会一直显示"按进度估算"。
      if (
        fresh.status === r.status &&
        fresh.audioUrl === r.audioUrl &&
        fresh.title === r.title &&
        fresh.durationMs === r.durationMs &&
        fresh.lyrics === r.lyrics &&
        fresh.rewrittenLyrics === r.rewrittenLyrics &&
        fresh.lyricLrc === r.lyricLrc &&
        fresh.coverUrl === r.coverUrl
      ) {
        return r;
      }
      changed = true;
      return fresh;
    });
    if (changed) set({ queue: nextQueue });
  },
}));
