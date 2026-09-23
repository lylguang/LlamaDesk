import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FilmIcon, Loader2Icon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { MediaSourceBadge } from "@components/media-source-badge";
import {
  MediaDownloadButton,
  RecordDeleteButton,
  RecordDeleteDialog,
} from "@components/record-actions";
import { Badge } from "@ui/badge";
import { ScrollArea } from "@ui/scroll-area";
import { Spinner } from "@ui/spinner";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuItem,
} from "@ui/sidebar";
import { useVideoStore } from "@stores/video";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import { downloadVideo } from "./parts";

export function VideoRecordList() {
  const t = useT();
  const { focusRecordId, setFocusRecordId, setView } = useVideoStore();
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["video-records"],
    queryFn: () => rpcClient.listVideoRecords(undefined),
  });
  const records = data?.records ?? [];

  const deleteMutation = useMutation({
    mutationFn: (id: number) => rpcClient.deleteVideoRecord({ id }),
    onSuccess: (_r, id) => {
      // 删掉的正好是当前聚焦的那条时把选中收回去，否则右侧会停在一条已经不存在的记录上。
      if (focusRecordId === id) setFocusRecordId(null);
      setConfirmDelete(null);
      queryClient.invalidateQueries({ queryKey: ["video-records"] });
    },
  });

  return (
    <SidebarGroup className="min-h-0 flex-1">
      <SidebarGroupLabel>
        <FilmIcon className="size-3.5" />
        {t("video.history.title")}
        <SidebarMenuBadge>
          <Badge variant="secondary" className="h-5 text-[10px]">
            {records.length}
          </Badge>
        </SidebarMenuBadge>
      </SidebarGroupLabel>

      <ScrollArea className="min-h-0 flex-1">
        <SidebarMenu className="gap-1">
          {isLoading ? (
            <div className="flex justify-center py-6">
              <Spinner className="size-3.5" />
            </div>
          ) : records.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">
              {t("video.history.empty")}
            </div>
          ) : (
            records.map((r) => (
              <SidebarMenuItem key={r.id} className="group/video px-1">
                {/* 行本身是 div[role=button] 而不是 <button>：里面还要放下载/删除两个按钮，
                    按钮不能嵌套。 */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    setView("generate");
                    setFocusRecordId(r.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setView("generate");
                      setFocusRecordId(r.id);
                    }
                  }}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2 rounded-md border p-1.5 text-left outline-none transition-colors",
                    focusRecordId === r.id
                      ? "border-primary/60 bg-primary/5"
                      : "hover:bg-muted/60 focus-visible:bg-muted/60",
                  )}
                >
                  {r.videoUrl ? (
                    <video
                      src={`${r.videoUrl}#t=0.1`}
                      muted
                      preload="metadata"
                      className="size-9 shrink-0 rounded bg-muted object-cover"
                    />
                  ) : (
                    <span
                      className={cn(
                        "flex size-9 shrink-0 items-center justify-center rounded bg-muted",
                        r.status === "failed" && "text-destructive/70",
                      )}
                    >
                      {r.status === "processing" ? (
                        <Loader2Icon className="size-3.5 animate-spin text-primary" />
                      ) : (
                        <FilmIcon className="size-3.5 text-muted-foreground" />
                      )}
                    </span>
                  )}
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="line-clamp-2 text-[11px] leading-snug text-foreground/80">
                      {r.prompt || t("video.error")}
                    </span>
                    <span className="flex items-center gap-1 text-[10px] text-muted-foreground/70 tabular-nums">
                      {r.status === "processing" && (
                        <span className="text-primary">{t("video.status.processing")}</span>
                      )}
                      {r.status === "failed" && (
                        <span className="text-destructive/80">{t("video.status.failed")}</span>
                      )}
                      <span>
                        {new Date(r.createdAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                      <MediaSourceBadge source={r.source} />
                      {/* 操作按钮跟着第二行走（这一行右边本来是空的），不占提示词的宽度。 */}
                      <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/video:opacity-100 group-focus-within/video:opacity-100">
                        {r.videoUrl && (
                          <MediaDownloadButton
                            compact
                            labels={{ idle: t("video.result.download") }}
                            save={() => downloadVideo(r.videoUrl!, r)}
                          />
                        )}
                        <RecordDeleteButton
                          disabled={deleteMutation.isPending}
                          onDelete={() => setConfirmDelete(r.id)}
                        />
                      </span>
                    </span>
                  </span>
                </div>
              </SidebarMenuItem>
            ))
          )}
        </SidebarMenu>
      </ScrollArea>

      <RecordDeleteDialog
        open={confirmDelete != null}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
        title={t("video.history.deleteTitle")}
        description={t("video.history.deleteDesc")}
        pending={deleteMutation.isPending}
        onConfirm={() => confirmDelete != null && deleteMutation.mutate(confirmDelete)}
      />
    </SidebarGroup>
  );
}
