/**
 * 底部播放条（网易云那一条）：封面 + 歌名 + 上一首/播放/下一首 + 进度 + 循环 / 歌词 / 队列 / 音量。
 *
 * 几条刻意的取舍：
 *  - **进度条自己画**（`Bar`）而不是用 `<input type="range">`：原生控件在不同平台上的
 *    内边距、轨道高度、滑块样式都不一致，而这条是要贴着主题走的；同时它也复用作音量条。
 *  - **拖动时立即 seek**：音频在回环地址上，跳转是本地操作，即时生效比"松手才动"顺手；
 *    进度值以元素为准（`seek()` 会把 `currentTime` 读回来），拖动期间不会被 `timeupdate` 顶回去。
 *  - **没有队列时也整条显示**，只把按钮置灰并写明"还没有在播放的歌曲" ——
 *    播放条忽隐忽现会让整个页面高度跳动。
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  Disc3Icon,
  ListMusicIcon,
  MusicIcon,
  PauseIcon,
  PlayIcon,
  Repeat1Icon,
  RepeatIcon,
  ShuffleIcon,
  SkipBackIcon,
  SkipForwardIcon,
  Volume1Icon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react";

import { Button } from "@ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@ui/popover";
import { useT } from "@stores/ui-lang";
import { useMusicStore } from "@stores/music";
import { isPlayable, useMusicPlayer, type MusicRepeatMode } from "@stores/music-player";
import { cn } from "@/mainview/lib/utils";
import { MusicCover, PlayingBars, recordSeed } from "./cover";
import { displayName, formatDuration } from "./parts";

export function MusicPlayerBar() {
  const t = useT();
  const { toggleQueue, toggleNowPlaying, nowPlaying } = useMusicStore();
  // 进度相关字段会以 4Hz 刷新，这里确实是它们的渲染点，订阅是必要的。
  // 动作用 getState 取（引用稳定），避免把整店订阅进来。
  const {
    toggle,
    next,
    prev,
    seek,
    setVolume,
    toggleMute,
    cycleRepeat,
  } = useMusicPlayer.getState();
  const queue = useMusicPlayer((s) => s.queue);
  const index = useMusicPlayer((s) => s.index);
  const playing = useMusicPlayer((s) => s.playing);
  const repeat = useMusicPlayer((s) => s.repeat);
  const volume = useMusicPlayer((s) => s.volume);
  const muted = useMusicPlayer((s) => s.muted);
  const currentTime = useMusicPlayer((s) => s.currentTime);
  const duration = useMusicPlayer((s) => s.duration);
  const source = useMusicPlayer((s) => s.source);
  const error = useMusicPlayer((s) => s.error);

  const record = index >= 0 ? queue[index] : undefined;
  const canPlay = isPlayable(record);
  // 时长以元素为准；元数据还没到时用记录的估算值兜底（列表里显示的也是这个）。
  const totalSeconds = duration > 0 ? duration : (record?.durationMs ?? 0) / 1000;
  const repeatIcon = repeat === "single" ? Repeat1Icon : repeat === "shuffle" ? ShuffleIcon : RepeatIcon;
  const RepeatGlyph = repeatIcon;
  const VolumeGlyph = muted || volume === 0 ? VolumeXIcon : volume < 0.5 ? Volume1Icon : Volume2Icon;

  return (
    <div className="flex h-[68px] shrink-0 items-center gap-3 border-t bg-card/60 px-4">
      {/* 左：封面 + 歌名（点封面 = 进单曲播放页：转盘 + 歌词，和网易云一致） */}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <button
          type="button"
          aria-label={t("music.now.open")}
          className="group/cover relative shrink-0"
          onClick={toggleNowPlaying}
        >
          {record ? (
            <MusicCover
              seed={recordSeed(record)}
              label={displayName(record)}
              src={record.coverUrl}
              className="size-11 rounded-lg shadow-sm"
            >
              {playing && (
                <span className="absolute inset-0 flex items-center justify-center bg-black/35">
                  <PlayingBars className="[&>span]:bg-white" />
                </span>
              )}
            </MusicCover>
          ) : (
            <span className="flex size-11 items-center justify-center rounded-lg border bg-muted">
              <MusicIcon className="size-4 text-muted-foreground" />
            </span>
          )}
        </button>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-xs font-medium">
            {record ? displayName(record) || t("music.untitled") : t("music.player.noTrack")}
          </span>
          <span className="truncate text-[10px] text-muted-foreground">
            {error
              ? // error 存的是词条键（store 里拿不到语言），在这里翻译。
                t(error)
              : source
                ? t("music.player.playingFrom", { name: source.name })
                : (record?.model ?? "")}
          </span>
        </div>
      </div>

      {/* 中：控制 + 进度 */}
      <div className="flex w-[38%] min-w-[240px] max-w-xl shrink-0 flex-col items-center gap-1">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            tooltip={t("music.player.prev")}
            aria-label={t("music.player.prev")}
            disabled={queue.length === 0}
            onClick={prev}
          >
            <SkipBackIcon className="size-4" />
          </Button>
          <Button
            size="icon-sm"
            className="size-8 rounded-full"
            tooltip={playing ? t("music.player.pause") : t("music.player.play")}
            aria-label={playing ? t("music.player.pause") : t("music.player.play")}
            disabled={!canPlay && queue.length === 0}
            onClick={toggle}
          >
            {playing ? (
              <PauseIcon className="size-4 fill-current" />
            ) : (
              <PlayIcon className="size-4 fill-current" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            tooltip={t("music.player.next")}
            aria-label={t("music.player.next")}
            disabled={queue.length === 0}
            onClick={() => next(false)}
          >
            <SkipForwardIcon className="size-4" />
          </Button>
        </div>

        <div className="flex w-full items-center gap-2">
          <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
            {formatClock(currentTime)}
          </span>
          <Bar
            ariaLabel={t("music.player.progress")}
            className="h-1.5 flex-1"
            value={currentTime}
            max={totalSeconds}
            disabled={!canPlay}
            onChange={seek}
          />
          <span className="w-9 shrink-0 text-[10px] tabular-nums text-muted-foreground">
            {duration > 0
              ? formatClock(duration)
              : record?.durationMs
                ? `~${formatDuration(record.durationMs)}`
                : "--:--"}
          </span>
        </div>
      </div>

      {/* 右：循环 / 歌词 / 队列 / 音量 */}
      <div className="flex flex-1 items-center justify-end gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          tooltip={t("music.player.repeat", { mode: t(REPEAT_LABEL[repeat]) })}
          aria-label={t("music.player.repeat", { mode: t(REPEAT_LABEL[repeat]) })}
          className={cn(repeat !== "list" && "text-primary")}
          onClick={cycleRepeat}
        >
          <RepeatGlyph className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          tooltip={t("music.now.open")}
          aria-label={t("music.now.open")}
          className={cn(nowPlaying && "text-primary")}
          onClick={toggleNowPlaying}
        >
          <Disc3Icon className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          tooltip={t("music.player.queue")}
          aria-label={t("music.player.queue")}
          onClick={toggleQueue}
        >
          <ListMusicIcon className="size-4" />
        </Button>

        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              tooltip={muted ? t("music.player.unmute") : t("music.player.mute")}
              aria-label={muted ? t("music.player.unmute") : t("music.player.mute")}
              onClick={toggleMute}
            >
              <VolumeGlyph className="size-4" />
            </Button>
          </PopoverTrigger>
          {/* 音量条：竖着放在按钮上方，不挤占播放条宽度。 */}
          <PopoverContent side="top" align="center" className="w-auto p-3">
            <Bar
              ariaLabel={t("music.player.volume")}
              className="h-1.5 w-28"
              value={muted ? 0 : volume}
              max={1}
              onChange={setVolume}
            />
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

const REPEAT_LABEL: Record<MusicRepeatMode, string> = {
  list: "music.player.repeat.list",
  single: "music.player.repeat.single",
  shuffle: "music.player.repeat.shuffle",
};

/** 秒 → m:ss（时长未知时给 --:--）。 */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * 可拖动的进度 / 音量条。
 *
 * 用指针事件 + `setPointerCapture`：拖出元素外也能继续跟手（原生 range 在播放条这种
 * 细条上很容易拖丢）。拖动过程持续回调 `onChange`，由调用方决定是即时生效还是只预览。
 */
function Bar({
  value,
  max,
  onChange,
  className,
  ariaLabel,
  disabled,
}: {
  value: number;
  max: number;
  onChange: (value: number) => void;
  className?: string;
  ariaLabel: string;
  disabled?: boolean;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;

  const valueAt = (clientX: number): number => {
    const el = trackRef.current;
    if (!el || max <= 0) return 0;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const r = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return r * max;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    onChange(valueAt(e.clientX));
  };

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      onPointerDown={onPointerDown}
      onPointerMove={(e) => {
        if (dragging) onChange(valueAt(e.clientX));
      }}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      onKeyDown={(e) => {
        if (disabled) return;
        const step = max > 2 ? 5 : max / 20;
        if (e.key === "ArrowRight") onChange(Math.min(max, value + step));
        if (e.key === "ArrowLeft") onChange(Math.max(0, value - step));
      }}
      className={cn(
        "group/bar relative flex cursor-pointer touch-none items-center outline-none",
        disabled && "cursor-default opacity-60",
        className,
      )}
    >
      <span className="h-full w-full overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full rounded-full bg-primary/80 transition-[width] duration-75 group-hover/bar:bg-primary"
          style={{ width: `${ratio * 100}%` }}
        />
      </span>
      <span
        className={cn(
          "absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow opacity-0 transition-opacity",
          "group-hover/bar:opacity-100 group-focus-visible/bar:opacity-100",
          dragging && "opacity-100",
        )}
        style={{ left: `${ratio * 100}%` }}
      />
    </div>
  );
}
