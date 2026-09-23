/**
 * 右侧抽屉：**只放播放队列**。
 *
 * 歌词已经搬到「单曲播放页」（`now-playing.tsx`：左转盘 + 右滚动歌词）—— 那是网易云
 * 放歌词的地方，320px 的窄抽屉既盛不下歌词，也做不出转盘那种版面。
 * 队列留在这里：它本来就是"从旁边拉出来看一眼、点一首就收起来"的东西。
 */
import { ChevronRightIcon, ListMusicIcon, ListXIcon, MusicIcon, Trash2Icon, XIcon } from "lucide-react";

import { Button } from "@ui/button";
import { ScrollArea } from "@ui/scroll-area";
import { useT } from "@stores/ui-lang";
import { useMusicStore } from "@stores/music";
import { isPlayable, useMusicPlayer } from "@stores/music-player";
import { cn } from "@/mainview/lib/utils";
import { MusicCover, PlayingBars, recordSeed } from "./cover";
import { displayName, formatDuration } from "./parts";

export function MusicPanel() {
  const t = useT();
  const { queueOpen, setQueueOpen } = useMusicStore();
  const queueLength = useMusicPlayer((s) => s.queue.length);

  if (!queueOpen) return null;

  return (
    <aside className="flex w-[320px] shrink-0 flex-col border-l bg-card/40">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <ListMusicIcon className="size-3.5 text-muted-foreground" />
        <span className="text-[11px] font-medium">{t("music.player.queue")}</span>
        {queueLength > 0 && (
          <span className="text-[10px] tabular-nums text-muted-foreground">{queueLength}</span>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          tooltip={t("common.close")}
          aria-label={t("common.close")}
          className="ml-auto size-6 text-muted-foreground"
          onClick={() => setQueueOpen(false)}
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>

      <QueuePanel />
    </aside>
  );
}

// ---------------------------------------------------------------------------
// 播放队列
// ---------------------------------------------------------------------------

/** 空队列 / 空列表的占位。 */
function PanelHint({ text }: { text: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <MusicIcon className="size-6 text-muted-foreground/60" />
      <p className="text-[11px] text-muted-foreground">{text}</p>
    </div>
  );
}

function QueuePanel() {
  const t = useT();
  const { jumpTo, removeFromQueue, clearQueue } = useMusicPlayer.getState();
  const queue = useMusicPlayer((s) => s.queue);
  const index = useMusicPlayer((s) => s.index);
  const playing = useMusicPlayer((s) => s.playing);
  const source = useMusicPlayer((s) => s.source);
  const { setFocusRecordId, setView } = useMusicStore();
  const playableCount = queue.filter(isPlayable).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 py-2 text-[10px] text-muted-foreground">
        <span className="truncate">
          {t("music.player.playingFrom", { name: source?.name ?? t("music.player.queueTitle") })}
        </span>
        <span className="ml-auto shrink-0 tabular-nums">{queue.length}</span>
        {queue.length > 0 && (
          <Button
            variant="ghost"
            size="icon-sm"
            tooltip={t("music.player.clearQueue")}
            aria-label={t("music.player.clearQueue")}
            className="size-6 text-muted-foreground hover:text-destructive"
            onClick={clearQueue}
          >
            <Trash2Icon className="size-3" />
          </Button>
        )}
      </div>

      {queue.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <PanelHint text={t("music.player.queueEmpty")} />
          <div className="shrink-0 border-t p-2">
            <Button
              variant="outline"
              size="sm"
              className="w-full text-[11px]"
              onClick={() => setView("generate")}
            >
              {t("music.nav.generate")}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-0.5 p-1.5">
              {queue.map((r, i) => {
                const current = i === index;
                const playable = isPlayable(r);
                return (
                  <div
                    key={`${r.id}-${i}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => playable && jumpTo(i)}
                    onKeyDown={(e) => {
                      if ((e.key === "Enter" || e.key === " ") && playable) {
                        e.preventDefault();
                        jumpTo(i);
                      }
                    }}
                    title={playable ? undefined : t("music.track.notPlayable")}
                    className={cn(
                      "group/q flex items-center gap-2 rounded-md px-1.5 py-1.5 transition-colors",
                      playable ? "cursor-pointer hover:bg-muted/60" : "opacity-60",
                      current && "bg-primary/5",
                    )}
                  >
                    <MusicCover
                      seed={recordSeed(r)}
                      label={displayName(r)}
                      src={r.coverUrl}
                      className="size-7 shrink-0"
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span
                        className={cn(
                          "truncate text-[11px]",
                          current ? "font-medium text-primary" : "text-foreground/85",
                        )}
                      >
                        {displayName(r) || t("music.untitled")}
                      </span>
                      <span className="truncate text-[9px] tabular-nums text-muted-foreground/70">
                        {r.status !== "done"
                          ? t(
                              r.status === "processing"
                                ? "music.status.processing"
                                : "music.status.failed",
                            )
                          : r.durationMs
                            ? `~${formatDuration(r.durationMs)}`
                            : ""}
                      </span>
                    </span>
                    {current && playing && <PlayingBars />}
                    <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/q:opacity-100 group-focus-within/q:opacity-100">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        tooltip={t("music.track.openDetail")}
                        aria-label={t("music.track.openDetail")}
                        className="size-6 text-muted-foreground"
                        onClick={(e) => {
                          e.stopPropagation();
                          setFocusRecordId(r.id);
                          setView("generate");
                        }}
                      >
                        <ChevronRightIcon className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        tooltip={t("music.player.removeFromQueue")}
                        aria-label={t("music.player.removeFromQueue")}
                        className="size-6 text-muted-foreground hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeFromQueue(i);
                        }}
                      >
                        <ListXIcon className="size-3.5" />
                      </Button>
                    </span>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
          <p className="shrink-0 border-t px-3 py-1.5 text-[10px] text-muted-foreground/70">
            {playableCount === 0
              ? t("music.play.empty")
              : t("music.player.queueHint", { n: String(playableCount) })}
          </p>
        </>
      )}
    </div>
  );
}
