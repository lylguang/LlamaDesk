/**
 * 「加入歌单」菜单：曲目行、创作结果卡、队列行共用一个入口。
 *
 * 勾选状态从后端查（`musicRecordPlaylistIds`）而不是拿歌单数量猜 ——
 * 同一首歌可以同时在几个歌单里，本地推不出来。菜单打开时才查，关着不占请求。
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, ListPlusIcon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@ui/popover";
import { Spinner } from "@ui/spinner";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import { PlaylistCover } from "./cover";

export function AddToPlaylistButton({
  recordIds,
  className,
  compact,
  iconOnly = true,
}: {
  recordIds: number[];
  className?: string;
  /** 列表行里的小尺寸（与下载 / 删除按钮同高）。 */
  compact?: boolean;
  iconOnly?: boolean;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  /** 刚加进去的歌单：给一个"已加入"的回执（这个应用没有 toast，就地反馈最稳）。 */
  const [justAdded, setJustAdded] = useState<number | null>(null);
  const [error, setError] = useState<string>();

  const playlistsQuery = useQuery({
    queryKey: ["music-playlists"],
    queryFn: () => rpcClient.listMusicPlaylists(undefined),
    enabled: open,
  });

  const membershipQuery = useQuery({
    queryKey: ["music-record-playlists", recordIds.join(",")],
    queryFn: () => rpcClient.musicRecordPlaylistIds({ recordIds }),
    enabled: open && recordIds.length > 0,
  });
  const membership = new Map(
    (membershipQuery.data?.entries ?? []).map((e) => [e.recordId, new Set(e.playlistIds)]),
  );
  /** 全部勾上才算"已经在里面"，只在一部分歌单里时仍然可以加。 */
  const inAll = (playlistId: number) =>
    recordIds.length > 0 && recordIds.every((id) => membership.get(id)?.has(playlistId));

  const add = useMutation({
    mutationFn: (playlistId: number) => rpcClient.addMusicToPlaylist({ playlistId, recordIds }),
    onSuccess: (r, playlistId) => {
      if (!r.ok) {
        setError(r.error ?? t("music.addToPlaylist.failed"));
        return;
      }
      setError(undefined);
      setJustAdded(playlistId);
      queryClient.invalidateQueries({ queryKey: ["music-playlists"] });
      queryClient.invalidateQueries({ queryKey: ["music-playlist-tracks"] });
      queryClient.invalidateQueries({ queryKey: ["music-record-playlists"] });
      // 回执留一会儿再落到勾选态上，让用户看清"加进哪个歌单了"。
      setTimeout(() => setJustAdded(null), 1200);
    },
    onError: (e) => setError(String(e)),
  });

  const playlists = playlistsQuery.data?.playlists ?? [];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size={compact ? "icon-sm" : "icon"}
          tooltip={t("music.addToPlaylist.title")}
          aria-label={t("music.addToPlaylist.title")}
          className={cn(compact && "size-6", className)}
          onClick={(e) => e.stopPropagation()}
        >
          <ListPlusIcon className={compact ? "size-3" : "size-3.5"} />
          {!iconOnly && <span>{t("music.addToPlaylist.title")}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1.5" onClick={(e) => e.stopPropagation()}>
        <p className="px-2 py-1 text-[10px] font-medium text-muted-foreground">
          {t("music.addToPlaylist.title")}
        </p>
        {playlistsQuery.isLoading ? (
          <div className="flex justify-center py-4">
            <Spinner className="size-3.5" />
          </div>
        ) : playlists.length === 0 ? (
          <p className="px-2 py-3 text-[11px] text-muted-foreground">
            {t("music.addToPlaylist.empty")}
          </p>
        ) : (
          <div className="max-h-64 overflow-y-auto">
            {playlists.map((p) => {
              const exists = inAll(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={add.isPending}
                  onClick={() => add.mutate(p.id)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-muted/70 disabled:opacity-60"
                >
                  <PlaylistCover seeds={p.coverSeeds} className="size-7" />
                  <span className="min-w-0 flex-1 truncate text-[11px]">
                    {p.builtin ? t("music.playlist.default") : p.name}
                  </span>
                  {justAdded === p.id ? (
                    <span className="shrink-0 text-[10px] text-primary">
                      {t("music.addToPlaylist.added")}
                    </span>
                  ) : exists ? (
                    <CheckIcon className="size-3.5 shrink-0 text-primary" />
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
        {error && <p className="px-2 py-1 text-[10px] text-destructive">{error}</p>}
      </PopoverContent>
    </Popover>
  );
}
