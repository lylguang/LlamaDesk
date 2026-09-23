import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { FileIcon, FileTextIcon, ScanTextIcon, SearchIcon, Trash2Icon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import type { DocumentStatus } from "@lib/constants";
import { RecordDeleteDialog } from "@components/record-actions";
import { Badge } from "@ui/badge";
import { ScrollArea } from "@ui/scroll-area";
import { Skeleton } from "@ui/skeleton";
import { Spinner } from "@ui/spinner";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarInput,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@ui/sidebar";
import { Label } from "@ui/label";
import { useRouter } from "@stores/router";
import { useOcrStore } from "@stores/ocr";
import { useT } from "@stores/ui-lang";
import { ToolSwitcher } from "@components/sidebar-parts";

const PAGE_SIZE = 30;
const RING_SIZE = 14;
const RING_STROKE = 2;

function DocStatusDot({
  status,
  processedPages,
  totalPages,
}: {
  status: DocumentStatus;
  processedPages?: number | undefined;
  totalPages?: number | undefined;
}) {
  if (status === "processing" && totalPages && totalPages > 0) {
    const progress = (processedPages ?? 0) / totalPages;
    const r = (RING_SIZE - RING_STROKE) / 2;
    const circumference = 2 * Math.PI * r;
    const offset = circumference * (1 - progress);

    return (
      <svg
        width={RING_SIZE}
        height={RING_SIZE}
        className="size-3.5! shrink-0 -rotate-90"
        viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      >
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={RING_STROKE}
          className="text-muted-foreground/30"
        />
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={RING_STROKE}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className="text-blue-500 transition-[stroke-dashoffset] duration-300"
        />
      </svg>
    );
  }

  if (status === "processing") {
    return <Spinner className="size-3.5! shrink-0 text-muted-foreground" />;
  }

  const color =
    status === "completed"
      ? "bg-emerald-500"
      : status === "failed"
        ? "bg-red-500"
        : "bg-muted-foreground/50";

  return <span className={`size-2 shrink-0 rounded-full ${color}`} />;
}

export function OcrRecordList() {
  const { route, setRoute } = useRouter();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const t = useT();
  const tab = useOcrStore((s) => s.tab);
  const setTab = useOcrStore((s) => s.setTab);

  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timeout);
  }, [search]);

  const { data, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage } = useInfiniteQuery({
    queryKey: ["documents", debouncedSearch],
    queryFn: async ({ pageParam = 0 }) => {
      return rpcClient.getDocuments({
        limit: PAGE_SIZE,
        offset: pageParam as number,
        search: debouncedSearch || "",
      });
    },
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.documents.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
    initialPageParam: 0,
  });

  const docs = data?.pages.flatMap((p) => p.documents) ?? [];
  const total = data?.pages[0]?.total ?? 0;

  const deleteMutation = useMutation({
    mutationFn: (id: number) => rpcClient.deleteDocument({ id }),
    onSuccess: (_r, id) => {
      // 删的是当前正在看的那份：先回列表页，否则详情页会停在一个已经不存在的文档上。
      if (route.path === "document" && route.id === id) setRoute({ path: "index" });
      setConfirmDelete(null);
      queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
  });

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
          fetchNextPage();
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <SidebarGroup className="min-h-0 flex-1 gap-1">
      {/* OCR 工具菜单：识别提取 / 文档处理（与生图页侧栏入口同款） */}
      <ToolSwitcher
        columns={2}
        active={tab}
        onSelect={setTab}
        items={[
          { key: "extract", icon: <ScanTextIcon className="size-4" />, labelKey: "ocr.tab.extract" },
          { key: "docs", icon: <FileTextIcon className="size-4" />, labelKey: "ocr.tab.docs" },
        ]}
      />
      <SidebarGroupLabel>
        <span className="flex items-center gap-1.5">
          <ScanTextIcon className="size-3.5" />
          {t("apps.ocr")}
        </span>
        <Badge variant="secondary" className="ml-auto h-5 shrink-0 px-1.5 text-[10px]">
          {total}
        </Badge>
      </SidebarGroupLabel>

      <SidebarGroupContent className="relative">
        <Label htmlFor="ocr-search" className="sr-only">
          {t("nav.search")}
        </Label>
        <SidebarInput
          id="ocr-search"
          placeholder={t("nav.search")}
          className="h-7 pl-8 text-xs"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 opacity-50 select-none" />
      </SidebarGroupContent>

      <ScrollArea className="min-h-0 flex-1">
        <SidebarMenu className="gap-0.5">
          {isLoading ? (
            Array.from({ length: 3 }).map((_, i) => (
              <SidebarMenuItem key={i}>
                <div className="flex flex-col gap-1 rounded-md p-2">
                  <Skeleton className="h-3.5 w-3/4" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              </SidebarMenuItem>
            ))
          ) : docs.length === 0 ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              {debouncedSearch ? t("models.noResults") : t("ocr.noDocs")}
            </div>
          ) : (
            <>
              {docs.map((doc) => {
                const isActive = route.path === "document" && route.id === doc.id;
                return (
                  <SidebarMenuItem key={doc.id}>
                    <SidebarMenuButton
                      isActive={isActive}
                      onClick={() => setRoute({ path: "document", id: doc.id })}
                      tooltip={doc.name}
                    >
                      {/* 左侧：图片缩略图 / PDF 图标 / 通用文件图标。 */}
                      <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted">
                        {doc.kind === "pdf" ? (
                          <FileTextIcon className="size-4 text-red-500" />
                        ) : doc.thumbUrl ? (
                          <img
                            src={doc.thumbUrl}
                            alt=""
                            loading="lazy"
                            className="size-full object-cover"
                          />
                        ) : (
                          <FileIcon className="size-3.5 text-muted-foreground" />
                        )}
                      </span>
                      {/* 右侧：识别内容首行预览（识别记录文件名是 UUID，直接展示太丑），无内容时退回文件名。 */}
                      <span className="min-w-0 flex-1 truncate text-xs font-medium">
                        {doc.preview || doc.name}
                      </span>
                      <DocStatusDot
                        status={doc.status as DocumentStatus}
                        processedPages={doc.processedPages ?? undefined}
                        totalPages={doc.totalPages ?? undefined}
                      />
                    </SidebarMenuButton>
                    {/* 悬浮整行才出现，并由 SidebarMenuButton 自动让出右侧 32px（pr-8）。
                        必须是兄弟节点而不是塞进按钮里 —— 按钮不能嵌套。 */}
                    <SidebarMenuAction
                      showOnHover
                      title={t("common.delete")}
                      disabled={deleteMutation.isPending}
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDelete(doc.id);
                      }}
                      // 别改 top：基类里的 `peer-data-[size=default]/menu-button:top-1.5`
                      // 带 peer 变体，特异性高于普通工具类，top-1/2 会被它压掉，
                      // 再叠一个 -translate-y-1/2 就把按钮顶到行的中线上方去了。
                      // 默认的 top-1.5 + 20px 高度正好落在这条 32px 行的垂直居中。
                      className="right-1 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2Icon className="size-3.5" />
                    </SidebarMenuAction>
                  </SidebarMenuItem>
                );
              })}
              <div ref={sentinelRef} className="h-1" />
              {isFetchingNextPage && (
                <div className="flex justify-center py-1.5">
                  <Spinner className="size-3.5" />
                </div>
              )}
            </>
          )}
        </SidebarMenu>
      </ScrollArea>

      <RecordDeleteDialog
        open={confirmDelete != null}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
        title={t("ocr.docs.deleteTitle")}
        description={t("ocr.docs.deleteDesc")}
        pending={deleteMutation.isPending}
        onConfirm={() => confirmDelete != null && deleteMutation.mutate(confirmDelete)}
      />
    </SidebarGroup>
  );
}
