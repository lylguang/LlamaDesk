import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GripVerticalIcon, RotateCcwIcon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { cn } from "@lib/utils";
import { Button } from "@ui/button";
import { Switch } from "@ui/switch";
import { SettingsSection } from "@components/setting-ui";
import { useT } from "@stores/ui-lang";
import {
  APP_RAIL_LAYOUT_KEY,
  defaultRailLayout,
  moveRailEntry,
  resolveRailLayout,
  serializeRailLayout,
  toggleRailEntry,
  visibleRailEntries,
  type AppId,
  type RailLayoutEntry,
} from "@/shared/app-rail";
import { APP_ICONS } from "./app-rail";

/**
 * 设置 → 外观 → 左侧一级菜单：显示 / 隐藏 + 拖动排序，**配置的顺序就是展示的顺序**。
 *
 * 拖动是自己实现的（仓库没有 DnD 依赖，一条 15 行的固定列表也不值得引一个）：
 * 指针落在哪一行的上半就把拖动项插到那一行之前 —— 实时换位，而不是拖影 + 落点判定；
 * 左栏只有一列、行高一致，实时换位给的反馈最直接。指针监听挂在 **window** 上而不是行本身：
 * 换位会让这一行在 DOM 里搬家，而元素一旦被移动就会丢掉 pointer capture（拖到一半断掉）。
 * 手柄上按 ↑ / ↓ 也能排序：既照顾不用鼠标的人，也是唯一能在 happy-dom 里测到的路径
 * （那里的布局尺寸全是 0，指针几何没有意义）。
 *
 * 改动**即时保存**，不参与页面上那个「保存」按钮 —— 拖动排序没有"草稿"的概念，
 * 拖完切走才发现没保存等于白拖。写库失败就退回已保存的那份并明说，不停在一个没落盘的顺序上。
 */
export function AppRailMenuSection() {
  const t = useT();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  const saved = useMemo(
    () => resolveRailLayout(data?.settings?.[APP_RAIL_LAYOUT_KEY]),
    [data],
  );

  // 拖动过程中的顺序是本地草稿：一次拖动只写一次库，中途不打断手感。
  const [draft, setDraft] = useState<RailLayoutEntry[] | null>(null);
  const [dragging, setDragging] = useState<AppId | null>(null);
  const list = draft ?? saved;
  const visibleCount = visibleRailEntries(list).length;

  const save = useMutation({
    mutationFn: (entries: RailLayoutEntry[]) =>
      rpcClient.updateSettings({
        settings: { [APP_RAIL_LAYOUT_KEY]: serializeRailLayout(entries) },
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["settings"] }),
    // 写库失败：退回已保存的那份，别让界面停在一个没落盘的顺序上（下面给一行提示）。
    onError: () => setDraft(null),
  });

  const persist = (entries: RailLayoutEntry[]) => {
    if (serializeRailLayout(entries) === serializeRailLayout(saved)) {
      setDraft(null);
      return;
    }
    setDraft(entries);
    save.mutate(entries);
  };

  // 拖动 / 键盘都会在事件回调里读这三个"最新值"：订阅窗口事件时不能捕获旧闭包。
  const listRef = useRef(list);
  listRef.current = list;
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const persistRef = useRef(persist);
  persistRef.current = persist;
  const rowRefs = useRef<(HTMLLIElement | null)[]>([]);

  // 保存落地（saved 追上新顺序）后再撤掉草稿，避免中途闪回旧顺序。
  useEffect(() => {
    if (draft && serializeRailLayout(draft) === serializeRailLayout(saved)) setDraft(null);
  }, [draft, saved]);

  useEffect(() => {
    if (!dragging) return;
    /** 指针落在第几行的上半部分 → 拖动项应该落到第几位。 */
    const rowIndexAt = (clientY: number) => {
      const rows = rowRefs.current.filter(Boolean) as HTMLLIElement[];
      for (let i = 0; i < rows.length; i += 1) {
        const rect = rows[i]!.getBoundingClientRect();
        if (clientY < rect.top + rect.height / 2) return i;
      }
      return rows.length - 1;
    };
    const onMove = (event: PointerEvent) => {
      const current = listRef.current;
      const from = current.findIndex((entry) => entry.id === dragging);
      if (from < 0) return;
      const target = rowIndexAt(event.clientY);
      if (target < 0 || target === from) return;
      setDraft(moveRailEntry(current, from, target));
    };
    const finish = () => {
      setDragging(null);
      if (serializeRailLayout(listRef.current) !== serializeRailLayout(savedRef.current)) {
        persistRef.current(listRef.current);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setDraft(null);
      setDragging(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("keydown", onKey);
    // 拖的时候别把行里文字选成一串蓝。
    const previousSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("keydown", onKey);
      document.body.style.userSelect = previousSelect;
    };
  }, [dragging]);

  const name = (id: AppId) => t(`apps.${id}`);

  return (
    <SettingsSection
      title={t("settings.appearance.menu.title")}
      description={t("settings.appearance.menu.desc")}
      actions={
        <Button
          variant="outline"
          size="xs"
          disabled={save.isPending || serializeRailLayout(list) === ""}
          onClick={() => persist(defaultRailLayout())}
        >
          <RotateCcwIcon data-icon="inline-start" />
          {t("settings.appearance.menu.reset")}
        </Button>
      }
    >
      <ul className="flex flex-col">
        {list.map((entry, index) => (
          <li
            key={entry.id}
            ref={(el) => {
              rowRefs.current[index] = el;
            }}
            data-slot="rail-menu-row"
            data-app={entry.id}
            data-hidden={entry.hidden ? "true" : undefined}
            className={cn(
              "flex items-center gap-2 border-b px-4 py-1.5 last:border-b-0",
              dragging === entry.id && "bg-primary/5",
            )}
          >
            <button
              type="button"
              data-slot="rail-menu-handle"
              aria-label={t("settings.appearance.menu.drag", { name: name(entry.id) })}
              title={t("settings.appearance.menu.dragHint")}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                // 按住手柄时不要顺手把页面文字选上。
                event.preventDefault();
                setDragging(entry.id);
              }}
              onKeyDown={(event) => {
                if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                event.preventDefault();
                const target = event.key === "ArrowUp" ? index - 1 : index + 1;
                if (target < 0 || target >= list.length) return;
                persist(moveRailEntry(list, index, target));
              }}
              className={cn(
                "shrink-0 cursor-grab touch-none rounded p-0.5 text-muted-foreground/50 transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                dragging === entry.id && "cursor-grabbing bg-primary/10 text-foreground",
              )}
            >
              <GripVerticalIcon className="size-3.5" />
            </button>

            <span
              className={cn(
                "flex shrink-0 items-center text-muted-foreground [&>svg]:size-4!",
                entry.hidden && "opacity-50",
              )}
            >
              {APP_ICONS[entry.id]}
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-xs",
                entry.hidden && "text-muted-foreground",
              )}
            >
              {name(entry.id)}
            </span>

            <Switch
              size="sm"
              checked={!entry.hidden}
              aria-label={t("settings.appearance.menu.show", { name: name(entry.id) })}
              onCheckedChange={(next) => persist(toggleRailEntry(list, entry.id, !next))}
            />
          </li>
        ))}
      </ul>

      {visibleCount === 0 && (
        <p className="px-4 py-2 text-[11px] text-amber-600">
          {t("settings.appearance.menu.allHidden")}
        </p>
      )}
      {save.isError && (
        <p className="px-4 py-2 text-[11px] text-destructive">
          {t("settings.appearance.menu.saveFailed")}
        </p>
      )}
    </SettingsSection>
  );
}
