/**
 * 音乐页的左侧栏：创作 / 全部作品两个入口 + 歌单列表 + 新建歌单。
 *
 * 这一栏原来直接列"每条创作记录"，改成歌单之后信息层级与网易云一致：
 * 左边管"我从哪儿听"，右边管"听什么"。逐条记录不再在这里出现 ——
 * 它们都在歌单里（新作自动进默认歌单），要按记录浏览时走「全部作品」。
 *
 * 三条约定：
 *  - **默认歌单不能改名 / 删除**（后端也会拒），行内不给这两个按钮，避免点了才报错；
 *  - 建 / 改名 / 删除的失败原因原样显示在对话框里，不做静默失败；
 *  - 歌单列表的 queryKey 与曲目页共用 `["music-playlists"]`，任何一处写完都刷新它。
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LayoutGridIcon,
  ListMusicIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  SparklesIcon,
  TrashIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import { ScrollArea } from "@ui/scroll-area";
import { Spinner } from "@ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ui/dialog";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@ui/sidebar";
import { useMusicStore } from "@stores/music";
import { useT } from "@stores/ui-lang";
import type { MusicPlaylistSummary } from "../../../bun/music-playlists";
import { cn } from "@/mainview/lib/utils";
import { PlaylistCover } from "./cover";

/** 歌单名上限与后端一致（bun/music-playlists.ts 的 PLAYLIST_LIMITS.name）。 */
const NAME_MAX = 40;

export function MusicPlaylistSidebar() {
  const t = useT();
  const queryClient = useQueryClient();
  const { view, playlistId, openPlaylist, setView } = useMusicStore();
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<MusicPlaylistSummary | null>(null);
  const [deleting, setDeleting] = useState<MusicPlaylistSummary | null>(null);
  const [error, setError] = useState<string>();

  const { data, isLoading } = useQuery({
    queryKey: ["music-playlists"],
    queryFn: () => rpcClient.listMusicPlaylists(undefined),
  });
  const playlists = data?.playlists ?? [];

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["music-playlists"] });
  };

  const createMutation = useMutation({
    mutationFn: (name: string) => rpcClient.createMusicPlaylist({ name }),
    onSuccess: (r) => {
      if (!r.ok || !r.playlist) {
        setError(r.error ?? t("music.playlist.createFailed"));
        return;
      }
      setError(undefined);
      setCreating(false);
      // 建完直接进去：新建歌单的下一步一定是往里放歌，不该让用户再点一次。
      openPlaylist(r.playlist.id);
      invalidate();
    },
    onError: (e) => setError(String(e)),
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      rpcClient.renameMusicPlaylist({ id, name }),
    onSuccess: (r) => {
      if (!r.ok) {
        setError(r.error ?? t("music.playlist.renameFailed"));
        return;
      }
      setError(undefined);
      setRenaming(null);
      invalidate();
    },
    onError: (e) => setError(String(e)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => rpcClient.deleteMusicPlaylist({ id }),
    onSuccess: (r, id) => {
      if (!r.ok) {
        setError(r.error ?? t("music.playlist.deleteFailed"));
        setDeleting(null);
        return;
      }
      setError(undefined);
      setDeleting(null);
      // 删掉的正是当前打开的那个：退回创作页，右侧不会停在已不存在的歌单上。
      if (playlistId === id) setView("generate");
      invalidate();
    },
    onError: (e) => {
      setError(String(e));
      setDeleting(null);
    },
  });

  const openNameDialog = (target: MusicPlaylistSummary | null) => {
    setError(undefined);
    if (target) setRenaming(target);
    else setCreating(true);
  };

  return (
    <>
      <SidebarGroup>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={view === "generate"}
              onClick={() => setView("generate")}
              tooltip={t("music.nav.generateHint")}
            >
              <SparklesIcon className="size-4" />
              <span>{t("music.nav.generate")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={view === "history"}
              onClick={() => setView("history")}
              tooltip={t("music.nav.allHint")}
            >
              <LayoutGridIcon className="size-4" />
              <span>{t("music.nav.all")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>

      <SidebarGroup className="min-h-0 flex-1">
        <SidebarGroupLabel className="gap-1">
          <ListMusicIcon className="size-3.5" />
          {t("music.playlist.title")}
          <Button
            variant="ghost"
            size="icon-sm"
            tooltip={t("music.playlist.new")}
            aria-label={t("music.playlist.new")}
            className="ml-auto size-5 text-muted-foreground hover:text-foreground"
            onClick={() => openNameDialog(null)}
          >
            <PlusIcon className="size-3.5" />
          </Button>
        </SidebarGroupLabel>

        <ScrollArea className="min-h-0 flex-1">
          <SidebarMenu className="gap-0.5">
            {isLoading ? (
              <div className="flex justify-center py-6">
                <Spinner className="size-3.5" />
              </div>
            ) : playlists.length === 0 ? (
              <div className="py-6 text-center text-xs text-muted-foreground">
                {t("music.playlist.empty")}
              </div>
            ) : (
              playlists.map((p) => (
                <PlaylistRow
                  key={p.id}
                  playlist={p}
                  active={view === "playlist" && playlistId === p.id}
                  onOpen={() => openPlaylist(p.id)}
                  onRename={() => openNameDialog(p)}
                  onDelete={() => {
                    setError(undefined);
                    setDeleting(p);
                  }}
                />
              ))
            )}
          </SidebarMenu>
        </ScrollArea>
      </SidebarGroup>

      <NameDialog
        open={creating || !!renaming}
        title={renaming ? t("music.playlist.rename") : t("music.playlist.new")}
        description={renaming ? t("music.playlist.renameHint") : t("music.playlist.newHint")}
        confirmLabel={renaming ? t("common.save") : t("music.playlist.create")}
        initial={renaming?.name ?? ""}
        pending={createMutation.isPending || renameMutation.isPending}
        error={error}
        onClose={() => {
          setCreating(false);
          setRenaming(null);
          setError(undefined);
        }}
        onSubmit={(name) => {
          if (renaming) renameMutation.mutate({ id: renaming.id, name });
          else createMutation.mutate(name);
        }}
      />

      <Dialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("music.playlist.deleteTitle", { name: deleting?.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("music.playlist.deleteDesc")}</DialogDescription>
          </DialogHeader>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleting(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={deleteMutation.isPending}
              onClick={() => deleting && deleteMutation.mutate(deleting.id)}
            >
              {deleteMutation.isPending ? (
                <Loader2Icon data-icon="inline-start" className="animate-spin" />
              ) : (
                <TrashIcon data-icon="inline-start" />
              )}
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** 一行歌单：封面拼图 + 名字 + 曲目数，hover 出现改名 / 删除（默认歌单不给）。 */
function PlaylistRow({
  playlist,
  active,
  onOpen,
  onRename,
  onDelete,
}: {
  playlist: MusicPlaylistSummary;
  active: boolean;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  return (
    <SidebarMenuItem className="group/pl px-1">
      {/* 整行是 div[role=button] 而不是 <button>：里面还要放改名 / 删除两个按钮，按钮不能嵌套。 */}
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        }}
        className={cn(
          "flex w-full cursor-pointer items-center gap-2 rounded-md border p-1.5 text-left outline-none transition-colors",
          active
            ? "border-primary/60 bg-primary/5"
            : "border-transparent hover:bg-muted/60 focus-visible:bg-muted/60",
        )}
      >
        <PlaylistCover seeds={playlist.coverSeeds} className="size-9" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[11px] leading-snug text-foreground/85">
            {playlist.builtin ? t("music.playlist.default") : playlist.name}
          </span>
          <span className="text-[10px] tabular-nums text-muted-foreground/70">
            {t("music.playlist.songCount", { n: String(playlist.count) })}
          </span>
        </span>
        {/* 默认歌单不给改名 / 删除：后端也会拒，这里就不摆按钮，省掉一次注定失败的点击。 */}
        {!playlist.builtin && (
          <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/pl:opacity-100 group-focus-within/pl:opacity-100">
            <Button
              variant="ghost"
              size="icon-sm"
              tooltip={t("music.playlist.rename")}
              aria-label={t("music.playlist.rename")}
              className="size-6 text-muted-foreground"
              onClick={(e) => {
                e.stopPropagation();
                onRename();
              }}
            >
              <PencilIcon className="size-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              tooltip={t("music.playlist.delete")}
              aria-label={t("music.playlist.delete")}
              className="size-6 text-muted-foreground hover:text-destructive"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
            >
              <TrashIcon className="size-3" />
            </Button>
          </span>
        )}
      </div>
    </SidebarMenuItem>
  );
}

/** 新建 / 改名共用的输入对话框（两个动作只有初始值与回调不同）。 */
function NameDialog({
  open,
  title,
  description,
  confirmLabel,
  initial,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  initial: string;
  pending: boolean;
  error?: string;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const t = useT();
  const [name, setName] = useState(initial);
  // 打开时同步一次初值：同一组件实例要服务"新建"和"改名"两种场景。
  const [syncedFor, setSyncedFor] = useState<{ open: boolean; initial: string }>({ open, initial });
  if (syncedFor.open !== open || syncedFor.initial !== initial) {
    setSyncedFor({ open, initial });
    if (open) setName(initial);
  }

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="music-playlist-name" className="text-xs">
            {t("music.playlist.nameLabel")}
          </Label>
          <Input
            id="music-playlist-name"
            autoFocus
            maxLength={NAME_MAX}
            placeholder={t("music.playlist.namePlaceholder")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
          />
          <p className="text-right text-[10px] tabular-nums text-muted-foreground">
            {name.length}/{NAME_MAX}
          </p>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" disabled={pending || !name.trim()} onClick={submit}>
            {pending && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
