/**
 * 歌单曲目页（右侧主区）：大封面 + 播放全部 + 曲目表格，就是网易云那个"歌单详情"。
 *
 * 交互按播放器的既有约定来，不另造一套：
 *  - **点整行 = 播放这首，并把整个歌单作为队列**（顺序与右侧列表一致），
 *    这样"下一首"走的就是用户眼前看到的顺序；
 *  - 生成中 / 失败的作品留在列表里（它们确实在歌单里），但点不动，行上写明状态 ——
 *    灰掉比"点了没反应"清楚；
 *  - 单首的增删都走各自的后端接口：加入歌单、从歌单移出、删除作品、下载，
 *    四件事的失败都会就地出错误文案（不做静默失败）。
 */
import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ListXIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  MusicIcon,
  PauseIcon,
  PlayIcon,
  ScrollTextIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { AudioDownloadButton, audioFileName } from "@components/audio-download";
import { MediaSourceBadge } from "@components/media-source-badge";
import { RecordDeleteDialog } from "@components/record-actions";
import { Button } from "@ui/button";
import { Badge } from "@ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@ui/popover";
import { ScrollArea } from "@ui/scroll-area";
import { Spinner } from "@ui/spinner";
import { useT } from "@stores/ui-lang";
import { useMusicStore } from "@stores/music";
import { isPlayable, useMusicPlayer } from "@stores/music-player";
import type { MusicRecordRow } from "../../../bun/music-gen";
import type { MusicPlaylistSummary } from "../../../bun/music-playlists";
import { cn } from "@/mainview/lib/utils";
import { AddToPlaylistButton } from "./add-to-playlist";
import { CoverMenu } from "./cover-menu";
import { CoverPlayOverlay, MusicCover, PlayingBars, PlaylistCover, recordSeed } from "./cover";
import { displayName, downloadName, formatDuration, formatTime, TASK_LABELS } from "./parts";

export function PlaylistView({ playlistId }: { playlistId: number }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { setView, setFocusRecordId, openNowPlaying } = useMusicStore();
  // 只订阅"当前在播哪首"这几个字段：进度每秒都在变，整店订阅会让整张表跟着重渲染。
  // 动作本身是稳定引用，按需取一次即可。
  const { playQueue, toggle } = useMusicPlayer.getState();
  const playing = useMusicPlayer((s) => s.playing);
  const queue = useMusicPlayer((s) => s.queue);
  const queueIndex = useMusicPlayer((s) => s.index);
  const queueSource = useMusicPlayer((s) => s.source);
  const [toDelete, setToDelete] = useState<MusicRecordRow | null>(null);
  const [error, setError] = useState<string>();

  const playlistsQuery = useQuery({
    queryKey: ["music-playlists"],
    queryFn: () => rpcClient.listMusicPlaylists(undefined),
  });
  const playlist: MusicPlaylistSummary | undefined = (playlistsQuery.data?.playlists ?? []).find(
    (p) => p.id === playlistId,
  );

  const tracksQuery = useQuery({
    queryKey: ["music-playlist-tracks", playlistId],
    queryFn: () => rpcClient.listMusicPlaylistTracks({ playlistId }),
  });
  const records = tracksQuery.data?.records ?? [];
  const playable = records.filter(isPlayable);
  const playlistName = playlist
    ? playlist.builtin
      ? t("music.playlist.default")
      : playlist.name
    : t("music.playlist.title");

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["music-playlist-tracks", playlistId] });
    queryClient.invalidateQueries({ queryKey: ["music-playlists"] });
  };

  const removeMutation = useMutation({
    mutationFn: (recordId: number) => rpcClient.removeMusicFromPlaylist({ playlistId, recordId }),
    onSuccess: (r) => {
      if (!r.ok) {
        setError(r.error ?? t("music.track.removeFailed"));
        return;
      }
      setError(undefined);
      refresh();
    },
    onError: (e) => setError(String(e)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => rpcClient.deleteMusicRecord({ id }),
    onSuccess: (r, id) => {
      if (!r.ok) {
        setError(r.error ?? t("music.deleteFailed"));
        setToDelete(null);
        return;
      }
      setError(undefined);
      setToDelete(null);
      if (useMusicStore.getState().focusRecordId === id) setFocusRecordId(null);
      refresh();
      queryClient.invalidateQueries({ queryKey: ["music-records"] });
    },
    onError: (e) => {
      setError(String(e));
      setToDelete(null);
    },
  });

  // 当前在这一栏里播放的那首（队列来自别处时不高亮，避免"两处都说是正在播"）。
  const playingHere =
    queueSource?.playlistId === playlistId && queueIndex >= 0
      ? (queue[queueIndex]?.id ?? null)
      : null;

  const playAll = () => {
    if (playable.length === 0) {
      setError(t("music.play.empty"));
      return;
    }
    setError(undefined);
    // 从头播：队列就是右边的列表，顺序一致。
    playQueue(records, records[0]!.id, { playlistId, name: playlistName });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 歌单头：大封面 + 名字 + 元信息 + 播放全部 */}
      <div className="flex shrink-0 items-start gap-5 border-b px-6 py-5">
        <div className="group/cover relative">
          <PlaylistCover seeds={playlist?.coverSeeds ?? []} className="size-28 shadow-sm" />
          <button
            type="button"
            aria-label={t("music.playlist.playAll")}
            onClick={playAll}
            className="absolute inset-0 rounded-md"
          >
            <CoverPlayOverlay playing={playing && playingHere != null} />
          </button>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-xl font-semibold">{playlistName}</h1>
            {playlist?.builtin && (
              <Badge variant="secondary" className="h-5 shrink-0 text-[10px]">
                {t("music.playlist.autoBadge")}
              </Badge>
            )}
          </div>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            <span>{t("music.playlist.songCount", { n: String(records.length) })}</span>
            {playlist && (
              <>
                <span>·</span>
                <span>
                  {t("music.playlist.createdAt", { date: formatTime(playlist.createdAt) })}
                </span>
              </>
            )}
            {playlist?.builtin && <span className="w-full">{t("music.playlist.defaultHint")}</span>}
          </p>
          <div className="mt-1 flex items-center gap-2">
            <Button size="sm" className="gap-1.5" onClick={playAll} disabled={playable.length === 0}>
              <PlayIcon className="size-3.5" />
              {t("music.playlist.playAll")}
            </Button>
            <span className="text-[10px] text-muted-foreground">
              {playable.length < records.length
                ? t("music.playlist.playableHint", {
                      playable: String(playable.length),
                      total: String(records.length),
                    })
                : null}
            </span>
          </div>
        </div>
      </div>

      {error && (
        <div className="shrink-0 border-b px-6 py-2">
          <p className="text-xs text-destructive">{error}</p>
        </div>
      )}

      {tracksQuery.isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="size-4" />
        </div>
      ) : records.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <div className="flex size-16 items-center justify-center rounded-2xl bg-primary/15">
            <MusicIcon className="size-7 text-primary" />
          </div>
          <p className="text-sm font-medium">{t("music.playlist.emptyTracks")}</p>
          <p className="max-w-sm text-xs text-muted-foreground">{t("music.playlist.emptyTracksHint")}</p>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setView("generate")}>
            <SparklesIcon className="size-3.5" />
            {t("music.nav.generate")}
          </Button>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="px-4 pb-6">
            <TrackTableHeader />
            {records.map((r, i) => (
              <TrackRow
                key={r.id}
                record={r}
                index={i + 1}
                current={playingHere === r.id}
                playing={playing}
                onPlay={() => playQueue(records, r.id, { playlistId, name: playlistName })}
                onPause={() => toggle()}
                onLyrics={() => {
                  // 看歌词 = 播这首 + 进单曲播放页：那页里转盘和歌词都在，不用再另开一处。
                  playQueue(records, r.id, { playlistId, name: playlistName });
                  openNowPlaying();
                }}
                onRemove={() => removeMutation.mutate(r.id)}
                onDelete={() => setToDelete(r)}
                onOpenDetail={() => {
                  setFocusRecordId(r.id);
                  setView("generate");
                }}
              />
            ))}
          </div>
        </ScrollArea>
      )}

      <RecordDeleteDialog
        open={toDelete != null}
        onOpenChange={(open) => !open && setToDelete(null)}
        title={t("music.history.deleteTitle")}
        description={t("music.history.deleteDesc")}
        pending={deleteMutation.isPending}
        onConfirm={() => toDelete && deleteMutation.mutate(toDelete.id)}
      />
    </div>
  );
}

/** 表头：与行用同一套栅格（改列宽时两处一起改）。 */
const GRID = "grid grid-cols-[2.5rem_minmax(0,1fr)_5.5rem_3.5rem_6.5rem] items-center gap-2";

function TrackTableHeader() {
  const t = useT();
  return (
    <div
      className={cn(
        GRID,
        "sticky top-0 z-10 border-b bg-background/95 px-2 py-1.5 text-[10px] font-medium text-muted-foreground backdrop-blur",
      )}
    >
      <span className="text-center">{t("music.track.index")}</span>
      <span>{t("music.track.title")}</span>
      <span>{t("music.track.source")}</span>
      <span className="text-right">{t("music.track.duration")}</span>
      <span className="text-right">{t("music.track.actions")}</span>
    </div>
  );
}

/**
 * 一行曲目。
 *
 * 整行是 div[role=button]：行内还要放下载 / 加入歌单 / 更多三个按钮，按钮不能嵌套。
 * 生成中 / 失败的行不响应播放（`canPlay`），但其余操作照旧可用。
 */
function TrackRow({
  record,
  index,
  current,
  playing,
  onPlay,
  onPause,
  onLyrics,
  onRemove,
  onDelete,
  onOpenDetail,
}: {
  record: MusicRecordRow;
  index: number;
  current: boolean;
  playing: boolean;
  onPlay: () => void;
  onPause: () => void;
  onLyrics: () => void;
  onRemove: () => void;
  onDelete: () => void;
  onOpenDetail: () => void;
}) {
  const t = useT();
  const canPlay = isPlayable(record);
  const lyrics = record.rewrittenLyrics?.trim() || record.lyrics?.trim() || "";

  const activate = () => {
    if (!canPlay) return;
    if (current) onPause();
    else onPlay();
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={displayName(record) || t("music.untitled")}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      }}
      title={canPlay ? undefined : t("music.track.notPlayable")}
      className={cn(
        GRID,
        "group/row rounded-md px-2 py-1.5 text-left outline-none transition-colors",
        canPlay ? "cursor-pointer hover:bg-muted/60 focus-visible:bg-muted/60" : "opacity-70",
        current && "bg-primary/5",
      )}
    >
      {/* 序号位：正在播放的那一行换成跳动条，否则显示序号 */}
      <span className="flex items-center justify-center text-[11px] tabular-nums text-muted-foreground">
        {current ? (
          <span className="flex size-4 items-center justify-center">
            {playing ? <PlayingBars /> : <PauseIcon className="size-3 text-primary" />}
          </span>
        ) : (
          index
        )}
      </span>

      <span className="flex min-w-0 items-center gap-2">
        <MusicCover
          seed={recordSeed(record)}
          label={displayName(record)}
          src={record.coverUrl}
          className="size-8 shrink-0"
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={cn(
              "flex items-center gap-1.5 truncate text-[12px] leading-snug",
              current ? "font-medium text-primary" : "text-foreground/90",
            )}
          >
            <span className="truncate">{displayName(record) || t("music.untitled")}</span>
            {record.instrumental && (
              <Badge variant="secondary" className="h-4 shrink-0 px-1 text-[9px]">
                {t("music.instrumentalShort")}
              </Badge>
            )}
            {record.task && (
              <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px]">
                {t(TASK_LABELS[record.task])}
              </Badge>
            )}
          </span>
          <span className="truncate text-[10px] text-muted-foreground/80">
            {record.caption || record.model || ""}
          </span>
        </span>
      </span>

      <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
        <MediaSourceBadge source={record.source} />
      </span>

      <span className="text-right text-[11px] tabular-nums text-muted-foreground">
        {record.status === "processing" ? (
          <Loader2Icon className="ml-auto size-3 animate-spin text-primary" />
        ) : record.status === "failed" ? (
          <span className="text-destructive/80">{t("music.status.failed")}</span>
        ) : record.durationMs ? (
          <span title={t("music.track.durationEstimated")}>~{formatDuration(record.durationMs)}</span>
        ) : (
          "--"
        )}
      </span>

      <span className="flex items-center justify-end gap-0.5">
        {/* 操作按钮：默认让位给"时长"，hover / 键盘聚焦时才浮出来（与侧栏列表一致）。 */}
        <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100">
          {lyrics && (
            <Button
              variant="ghost"
              size="icon-sm"
              tooltip={t("music.track.lyrics")}
              aria-label={t("music.track.lyrics")}
              className="size-6 text-muted-foreground"
              onClick={(e) => {
                e.stopPropagation();
                onLyrics();
              }}
            >
              <ScrollTextIcon className="size-3" />
            </Button>
          )}
          <CoverMenu recordId={record.id} hasCover={!!record.coverUrl} compact />
          <AddToPlaylistButton recordIds={[record.id]} compact />
          {record.audioUrl && (
            <AudioDownloadButton
              compact
              url={record.audioUrl}
              filename={audioFileName(record.audioUrl, downloadName(record))}
            />
          )}
          <RowMenu onRemove={onRemove} onDelete={onDelete} onOpenDetail={onOpenDetail} />
        </span>
      </span>
    </div>
  );
}

/** 行尾的"更多"：从歌单移出 / 查看创作详情 / 删除作品。 */
function RowMenu({
  onRemove,
  onDelete,
  onOpenDetail,
}: {
  onRemove: () => void;
  onDelete: () => void;
  onOpenDetail: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const item = (icon: ReactNode, label: string, onClick: () => void, danger?: boolean) => (
    <button
      type="button"
      onClick={() => {
        setOpen(false);
        onClick();
      }}
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-muted/70",
        danger && "text-destructive hover:bg-destructive/10",
      )}
    >
      {icon}
      {label}
    </button>
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          tooltip={t("music.track.more")}
          aria-label={t("music.track.more")}
          className="size-6 text-muted-foreground"
          onClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontalIcon className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-44 p-1" onClick={(e) => e.stopPropagation()}>
        {item(<ListXIcon className="size-3.5" />, t("music.track.removeFromPlaylist"), onRemove)}
        {item(<SparklesIcon className="size-3.5" />, t("music.track.openDetail"), onOpenDetail)}
        {item(<Trash2Icon className="size-3.5" />, t("music.track.deleteWork"), onDelete, true)}
      </PopoverContent>
    </Popover>
  );
}
