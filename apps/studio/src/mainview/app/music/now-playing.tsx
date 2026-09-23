/**
 * 单曲播放页（网易云那个"点封面进去"的界面）：左侧黑胶转盘 + 右侧滚动歌词。
 *
 * 它盖在主区之上（不占独立路由），底部播放条照旧在下面 —— 上/下一首、进度、音量、
 * 循环都只有一份实现，这里不再重复一套控件。
 *
 * 三件事要说清楚：
 * 1. **歌词是按进度估算对齐的**。两家生音乐接口都只返回整段歌词文本，没有时间轴；
 *    这里把内容行按播放进度均分，高亮当前大致唱到的那一行。界面上写明了这一点，
 *    并且**点击某一行可以直接跳到那一段**（跳转用的也是这个估算时间）。
 * 2. **转盘暂停时停在当前角度**（`animation-play-state`），不是回到起点。
 * 3. 唱针只在播放时落到唱片上（暂停即抬起）—— 这是"正在放"最直观的那一下反馈。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLinesIcon,
  ChevronDownIcon,
  Loader2Icon,
  MusicIcon,
  PauseIcon,
  PlayIcon,
  WandSparklesIcon,
} from "lucide-react";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { rpcClient } from "@lib/rpc";
import { AudioDownloadButton, audioFileName } from "@components/audio-download";
import { Button } from "@ui/button";
import { useT } from "@stores/ui-lang";
import { useMusicStore } from "@stores/music";
import { isPlayable, useMusicPlayer } from "@stores/music-player";
import type { MusicRecordRow } from "../../../bun/music-gen";
import { cn } from "@/mainview/lib/utils";
import { AddToPlaylistButton } from "./add-to-playlist";
import { CoverMenu } from "./cover-menu";
import { coverStyle, MusicCover, PlayingBars, recordSeed } from "./cover";
import {
  currentLrcIndex,
  estimatedLineIndex,
  estimatedLineTime,
  parseLrc,
  parseLyrics,
} from "./lyrics";
import { displayName, downloadName, formatDuration } from "./parts";

export function NowPlayingView() {
  const t = useT();
  const closeNowPlaying = useMusicStore((s) => s.closeNowPlaying);
  const {
    toggle,
    next,
    prev,
    seek,
  } = useMusicPlayer.getState();
  const queue = useMusicPlayer((s) => s.queue);
  const index = useMusicPlayer((s) => s.index);
  const playing = useMusicPlayer((s) => s.playing);
  const source = useMusicPlayer((s) => s.source);
  const record = index >= 0 ? queue[index] : undefined;
  const canPlay = isPlayable(record);

  // Esc 收起：浮层该有的基本礼貌。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeNowPlaying();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeNowPlaying]);

  const title = record ? displayName(record) || t("music.untitled") : t("music.player.noTrack");

  return (
    <div className="music-page-in absolute inset-0 z-20 flex flex-col bg-background">
      {/* 背景：有真封面就用封面本身做模糊底（网易云那层氛围底色），没有才用渐变兜底 */}
      {record && (
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
          {record.coverUrl ? (
            <img
              src={record.coverUrl}
              alt=""
              className="size-full scale-125 object-cover opacity-[0.22] blur-3xl"
            />
          ) : (
            <div
              className="size-full scale-125 opacity-[0.16] blur-3xl"
              style={coverStyle(recordSeed(record))}
            />
          )}
        </div>
      )}

      <div className="relative flex shrink-0 items-center gap-3 px-5 py-3">
        <Button
          variant="ghost"
          size="icon-sm"
          tooltip={t("music.now.collapse")}
          aria-label={t("music.now.collapse")}
          onClick={closeNowPlaying}
        >
          <ChevronDownIcon className="size-4" />
        </Button>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">{title}</span>
          <span className="truncate text-[10px] text-muted-foreground">
            {source ? t("music.player.playingFrom", { name: source.name }) : (record?.model ?? "")}
          </span>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {record && <CoverMenu recordId={record.id} hasCover={!!record.coverUrl} />}
          {record && <AddToPlaylistButton recordIds={[record.id]} />}
          {record?.audioUrl && (
            <AudioDownloadButton
              url={record.audioUrl}
              filename={audioFileName(record.audioUrl, downloadName(record))}
            />
          )}
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col gap-6 px-6 pb-6 lg:flex-row lg:items-stretch lg:gap-10 lg:px-10">
        {/* 左：黑胶转盘 + 唱针 */}
        <div className="flex shrink-0 flex-col items-center justify-center gap-5 py-2 lg:w-[42%]">
          <VinylDisc
            seed={record ? recordSeed(record) : "omni"}
            label={title}
            src={record?.coverUrl}
            playing={playing && canPlay}
            onToggle={canPlay ? toggle : undefined}
          />
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon-sm"
              tooltip={t("music.player.prev")}
              aria-label={t("music.player.prev")}
              disabled={queue.length === 0}
              onClick={prev}
            >
              <ChevronDownIcon className="size-4 rotate-90" />
            </Button>
            <Button
              size="lg"
              className="size-11 rounded-full"
              tooltip={playing ? t("music.player.pause") : t("music.player.play")}
              aria-label={playing ? t("music.player.pause") : t("music.player.play")}
              disabled={!canPlay}
              onClick={toggle}
            >
              {playing ? (
                <PauseIcon className="size-5 fill-current" />
              ) : (
                <PlayIcon className="size-5 fill-current" />
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
              <ChevronDownIcon className="size-4 -rotate-90" />
            </Button>
          </div>
          {record?.durationMs ? (
            <span className="text-[10px] tabular-nums text-muted-foreground">
              ~{formatDuration(record.durationMs)}
            </span>
          ) : null}
        </div>

        {/* 右：滚动歌词 */}
        <LyricsScroller record={record} playing={playing} onSeek={seek} className="lg:flex-1" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 黑胶转盘
// ---------------------------------------------------------------------------

/** 唱片旋转速度：给暂停留出 `data-paused` 让浏览器停在当前角度（见 styles/index.css）。 */
function VinylDisc({
  seed,
  label,
  src,
  playing,
  onToggle,
}: {
  seed: string;
  label: string;
  /** 真封面（用户上传或生成的）；没有就画渐变。 */
  src?: string | null;
  playing: boolean;
  onToggle?: () => void;
}) {
  const t = useT();
  return (
    <div className="relative flex items-center justify-center">
      {/* 播放中在唱片背后慢慢呼吸的一圈光晕（静止时不显示，省得空转一个动画）。 */}
      <span
        aria-hidden
        className={cn(
          "absolute size-[86%] rounded-full blur-2xl",
          playing ? "music-halo bg-primary/25" : "opacity-0",
        )}
      />

      {/* 唱针：支点在盘右上方，播放时落到唱片外圈，暂停时抬起来。
          cubic-bezier 带一点回弹 —— 落针那一下要"顿"得住，匀速转过去像塑料。 */}
      <div
        aria-hidden
        className="absolute top-[-6%] right-[8%] z-10 w-2 origin-top transition-transform duration-700 ease-[cubic-bezier(0.34,1.4,0.64,1)]"
        style={{ transform: `rotate(${playing ? 4 : -26}deg)` }}
      >
        <span className="mx-auto block size-4 rounded-full bg-gradient-to-br from-zinc-200 to-zinc-500 shadow-md" />
        <span className="mx-auto block h-20 w-[5px] rounded-full bg-gradient-to-b from-zinc-300 via-zinc-400 to-zinc-600 shadow" />
        <span className="mx-auto -mt-1 block h-3 w-4 rounded-sm bg-zinc-700 shadow" />
      </div>

      <button
        type="button"
        aria-label={playing ? t("music.player.pause") : t("music.player.play")}
        onClick={onToggle}
        disabled={!onToggle}
        className={cn(
          "music-disc relative flex size-52 items-center justify-center rounded-full sm:size-60 xl:size-72",
          "shadow-[0_18px_45px_-12px_rgba(0,0,0,0.55)] outline-none",
          onToggle ? "cursor-pointer" : "cursor-default",
        )}
        data-paused={playing ? "false" : "true"}
      >
        {/* 黑胶本体：同心圆沟槽 */}
        <span
          className="absolute inset-0 rounded-full"
          style={{
            backgroundImage:
              "repeating-radial-gradient(circle at 50% 50%, #141417 0 1.6px, #24242a 1.6px 3.2px)",
          }}
        />
        {/* 边缘反光，让它在深色主题下也有轮廓 */}
        <span className="absolute inset-0 rounded-full ring-1 ring-white/10" />
        {/* 中心贴纸 = 封面 */}
        <MusicCover
          seed={seed}
          label={label}
          src={src}
          className="size-[44%] rounded-full ring-4 ring-black/40"
        />
        {/* 中心孔 */}
        <span className="absolute size-2.5 rounded-full bg-background/90 ring-1 ring-black/40" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 歌词
// ---------------------------------------------------------------------------

function LyricsScroller({
  record,
  playing,
  onSeek,
  className,
}: {
  record: MusicRecordRow | undefined;
  playing: boolean;
  onSeek: (seconds: number) => void;
  className?: string;
}) {
  const t = useT();
  const currentTime = useMusicPlayer((s) => s.currentTime);
  const duration = useMusicPlayer((s) => s.duration);
  const boxRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  // 歌词优先显示上游改写后的那份：跟着唱的是"实际唱出来的词"（与结果卡一致）。
  const lyrics = record?.rewrittenLyrics?.trim() || record?.lyrics?.trim() || "";
  const lines = useMemo(() => parseLyrics(lyrics), [lyrics]);
  const contentCount = useMemo(() => lines.filter((l) => !l.tag).length, [lines]);

  // 对齐过就用真时间轴（后端 ASR 对齐的结果），否则按进度估算。
  const lrc = useMemo(() => parseLrc(record?.lyricLrc ?? ""), [record?.lyricLrc]);
  const hasLrc = lrc.length > 0;

  const total = duration > 0 ? duration : (record?.durationMs ?? 0) / 1000;
  const activeIndex = hasLrc
    ? currentLrcIndex(lrc, currentTime)
    : estimatedLineIndex(currentTime, total, contentCount);

  useEffect(() => {
    const el = activeRef.current;
    const box = boxRef.current;
    if (!el || !box) return;
    box.scrollTo({
      top: Math.max(0, el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2),
      behavior: "smooth",
    });
  }, [activeIndex, lyrics, lrc]);

  const body = () => {
    if (!record) return <EmptyLyrics text={t("music.player.noTrack")} />;
    if (hasLrc) {
      // 对齐过的歌词：行就是后端对齐时用的那些内容行，时间是真的。
      return lrc.map((line, i) => (
        <button
          key={`${i}-${line.time}-${line.text}`}
          ref={i === activeIndex ? activeRef : undefined}
          type="button"
          onClick={() => onSeek(line.time)}
          className={cn(
            "block w-full rounded-md px-2 py-1.5 text-left text-[15px] leading-relaxed transition-colors",
            i === activeIndex
              ? "text-lg font-semibold text-primary"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {line.text}
        </button>
      ));
    }
    if (lines.length === 0) {
      return (
        <EmptyLyrics
          text={record.instrumental ? t("music.lyrics.instrumental") : t("music.lyrics.empty")}
        />
      );
    }
    // 还没对齐：按进度均分估算（界面上标明了，也给了一键对齐的入口）。
    let contentSeen = -1;
    return lines.map((line, i) => {
      if (line.tag) {
        return (
          <p
            key={`${i}-${line.text}`}
            className="mt-5 mb-1 text-[11px] font-medium tracking-wide text-muted-foreground/50"
          >
            {line.text}
          </p>
        );
      }
      contentSeen += 1;
      const lineIndex = contentSeen;
      const active = activeIndex >= 0 && lineIndex === activeIndex;
      const target = estimatedLineTime(lineIndex, contentCount, total);
      return (
        <button
          key={`${i}-${line.text}`}
          ref={active ? activeRef : undefined}
          type="button"
          disabled={target == null}
          onClick={() => target != null && onSeek(target)}
          title={target == null ? undefined : t("music.lyrics.seekHint")}
          className={cn(
            "block w-full rounded-md px-2 py-1.5 text-left text-[15px] leading-relaxed transition-colors",
            active
              ? "text-lg font-semibold text-primary"
              : "text-muted-foreground hover:text-foreground",
            target != null && "cursor-pointer",
          )}
        >
          {line.text}
        </button>
      );
    });
  };

  const canGenerate =
    !!record && !record.instrumental && record.task !== "music_cover" && record.task !== "vocal_to_music";

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      {record && (
        <LyricsToolbar
          record={record}
          hasLrc={hasLrc}
          hasLyrics={lines.length > 0}
          playing={playing}
          canGenerate={canGenerate}
        />
      )}
      <div
        ref={boxRef}
        className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-2 py-8 text-center lg:text-left"
      >
        {body()}
      </div>
    </div>
  );
}

/**
 * 歌词工具条：一键写词 / 一键对齐的状态与入口。
 *
 * "是否已经对齐"必须写在脸上 —— 估算和真时间轴在观感上差别很大，用户有权知道
 * 现在看的是哪一种（也才知道该不该点那个按钮）。
 */
function LyricsToolbar({
  record,
  hasLrc,
  hasLyrics,
  playing,
  canGenerate,
}: {
  record: MusicRecordRow;
  hasLrc: boolean;
  hasLyrics: boolean;
  playing: boolean;
  canGenerate: boolean;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string>();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["music-records"] });
    queryClient.invalidateQueries({ queryKey: ["music-playlist-tracks"] });
  };

  const generate = useMutation({
    mutationFn: () => rpcClient.generateMusicLyrics({ id: record.id }),
    onSuccess: (r) => {
      if (!r.ok) {
        setError(r.error ?? t("music.lyrics.generateFailed"));
        return;
      }
      setError(undefined);
      invalidate();
    },
    onError: (e) => setError(String(e)),
  });

  const align = useMutation({
    mutationFn: () => rpcClient.alignMusicLyrics({ id: record.id }),
    onSuccess: (r) => {
      if (!r.ok) {
        setError(r.error ?? t("music.lyrics.alignFailed"));
        return;
      }
      setError(undefined);
      invalidate();
    },
    onError: (e) => setError(String(e)),
  });

  const busy = generate.isPending || align.isPending;

  return (
    <div className="shrink-0 border-b border-border/60 px-2 pb-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "flex items-center gap-1 text-[10px]",
            hasLrc ? "text-primary/80" : "text-muted-foreground/80",
          )}
        >
          <span className={cn("size-1.5 rounded-full", hasLrc ? "bg-primary/70" : "bg-muted-foreground/40")} />
          {hasLrc ? t("music.lyrics.aligned") : t("music.lyrics.estimatedBadge")}
        </span>

        <span className="ml-auto flex items-center gap-1.5">
          {!hasLyrics && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 gap-1 text-[10px]"
              disabled={busy || !canGenerate}
              tooltip={canGenerate ? undefined : t("music.lyrics.generateBlocked")}
              onClick={() => generate.mutate()}
            >
              {generate.isPending ? (
                <Loader2Icon className="size-3 animate-spin" />
              ) : (
                <WandSparklesIcon className="size-3" />
              )}
              {t("music.lyrics.generate")}
            </Button>
          )}
          {hasLyrics && (
            <Button
              variant={hasLrc ? "ghost" : "outline"}
              size="sm"
              className="h-6 gap-1 text-[10px]"
              disabled={busy}
              onClick={() => align.mutate()}
            >
              {align.isPending ? (
                <Loader2Icon className="size-3 animate-spin" />
              ) : (
                <AudioLinesIcon className="size-3" />
              )}
              {hasLrc ? t("music.lyrics.realign") : t("music.lyrics.align")}
            </Button>
          )}
        </span>
      </div>

      {(busy || error) && (
        <p className={cn("mt-1.5 text-[10px] leading-relaxed", error ? "text-destructive" : "text-muted-foreground")}>
          {error ?? (align.isPending ? t("music.lyrics.aligning") : t("music.lyrics.generating"))}
        </p>
      )}
      {!busy && !error && !hasLrc && hasLyrics && (
        <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground/70">
          {t(playing ? "music.lyrics.estimated" : "music.lyrics.estimatedPaused")}
        </p>
      )}
    </div>
  );
}

function EmptyLyrics({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 text-center">
      <MusicIcon className="size-7 text-muted-foreground/60" />
      <p className="text-xs text-muted-foreground">{text}</p>
      <PlayingBars className="opacity-30" />
    </div>
  );
}
