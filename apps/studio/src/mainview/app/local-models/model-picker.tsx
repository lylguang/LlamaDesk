import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangleIcon, CheckIcon, ChevronDownIcon, FolderIcon, SearchIcon } from "lucide-react";

import { Input } from "@ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@ui/popover";
import { useT } from "@stores/ui-lang";
import { cn } from "@lib/utils";
import {
  engineSupports,
  fileKind,
  modelNameFromRef,
  type InferenceEngine,
  type InstalledModel,
} from "@/shared/modelscope";
import { filterModels } from "./model-filter";

/**
 * 「选择已下载的模型」—— 带检索的模型下拉。
 *
 * 本机模型几十条是常态（双平台下载 + HF 缓存 + 自己加的目录），纯下拉只能靠滚动条找，
 * 名字再长一点还会被截断。这里在列表上方放一个搜索框：输入即筛（模型名 / 仓库名都能搜），
 * ↑↓ 选、回车确认，当前使用的模型永远排第一条。
 *
 * 没走 `@ui/select`：Radix Select 的键盘接管会把搜索框里的字母当成首字母跳转
 * （在内容里放 input 是它明确不支持的用法），所以用 Popover 自己组合。
 */
export function ModelPicker({
  models,
  value,
  engine,
  onChange,
  disabled = false,
}: {
  models: InstalledModel[];
  /** 当前选择（模型路径）。 */
  value: string;
  /** 当前引擎：只用于给"会被自动切引擎"的模型打标。 */
  engine: InferenceEngine;
  onChange: (path: string) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const candidates = useMemo(
    () => models.filter((m) => m.category !== "embedding" && m.category !== "rerank"),
    [models],
  );
  // 空检索时的顺序 = 下拉展开时的顺序（当前模型置顶 + 名字自然序），高亮下标按它算。
  const sorted = useMemo(() => filterModels(candidates, ""), [candidates]);
  const visible = useMemo(
    () => (query.trim() ? filterModels(sorted, query) : sorted),
    [sorted, query],
  );
  const selected = candidates.find((m) => m.path === value || m.runtimeTarget === value);
  const isCurrent = (m: InstalledModel) => m.path === value || m.runtimeTarget === value;

  // 打开时把高亮落在当前选择上，接着按 ↑↓ 就是从"现在这个"往前后翻。
  useEffect(() => {
    if (!open) return;
    setQuery("");
    const index = sorted.findIndex(isCurrent);
    setHighlight(index >= 0 ? index : 0);
    // 只在打开的那一刻定位一次：之后 value 变化（选中即关）不该再把光标拽回去。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 高亮项跟着键盘走：列表比可视区高时，被选中的那条要能滚进来。
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight, open, visible]);

  const commit = (path: string) => {
    setOpen(false);
    if (path !== value) onChange(path);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (visible.length === 0) return;
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setHighlight((prev) => (prev + delta + visible.length) % visible.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const hit = visible[highlight] ?? visible[0];
      if (hit) commit(hit.path);
      return;
    }
    if (e.key === "Escape") setOpen(false);
  };

  const triggerLabel = selected?.fileName ?? modelNameFromRef(value, "");

  return (
    <Popover open={open} onOpenChange={(next) => !disabled && setOpen(next)}>
      <PopoverTrigger
        disabled={disabled}
        title={triggerLabel || t("models.chooseModel")}
        className={cn(
          "flex h-9 w-full min-w-0 items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent px-2.5 text-xs transition-colors outline-none select-none",
          "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
          "dark:bg-input/30 dark:hover:bg-input/50",
        )}
      >
        <span className={cn("truncate", !triggerLabel && "text-muted-foreground")}>
          {triggerLabel || t("models.chooseModelEmpty")}
        </span>
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="flex w-[30rem] max-w-[min(30rem,90vw)] flex-col gap-0 overflow-hidden p-0"
        // 打开就把光标放进搜索框：直接打字即筛，不用先点一下。
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          searchRef.current?.focus();
        }}
      >
        <div className="relative border-b p-2">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(0);
            }}
            onKeyDown={onKeyDown}
            placeholder={t("models.searchModel")}
            className="h-8 border-0 bg-transparent pl-7 text-xs focus-visible:ring-0 dark:bg-transparent"
          />
        </div>
        {visible.length === 0 ? (
          <p className="px-3 py-6 text-center text-[11px] text-muted-foreground">
            {query.trim() ? t("models.noMatchModel") : t("models.chooseModelEmpty")}
          </p>
        ) : (
          <>
            <div ref={listRef} className="max-h-80 overflow-y-auto p-1" role="listbox">
              {visible.map((m, index) => {
                const kind = m.kind ?? fileKind(m.fileName);
                const incompatible = !engineSupports(engine, kind);
                const current = isCurrent(m);
                return (
                  <button
                    key={m.path}
                    type="button"
                    role="option"
                    aria-selected={current}
                    data-index={index}
                    onClick={() => commit(m.path)}
                    onMouseEnter={() => setHighlight(index)}
                    className={cn(
                      "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                      index === highlight && "bg-foreground/10",
                    )}
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-1.5">
                      {m.isDir && <FolderIcon className="size-3 shrink-0 text-muted-foreground/60" />}
                      <span className="truncate">{m.fileName}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground/70">
                      {m.isActive && <span className="text-primary">{t("models.inUse")}</span>}
                      <span className="rounded-sm bg-muted px-1 text-[9px] leading-4 text-muted-foreground">
                        {kind === "gguf"
                          ? "GGUF"
                          : kind === "safetensors"
                            ? "safetensors"
                            : t("models.format.other")}
                      </span>
                      <span className="max-w-44 truncate">{m.repo}</span>
                      {/* 启动时会自动把引擎切过去（见 setActiveModel），这里只做告知；
                          和「模型库」列表里那一行的提示是同一个口径。 */}
                      {incompatible && (
                        <span className="inline-flex items-center gap-0.5 rounded bg-amber-100 px-1 text-[9px] leading-4 font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
                          <AlertTriangleIcon className="size-2.5" />
                          {t("models.autoSwitchEngine")}
                        </span>
                      )}
                      {current && <CheckIcon className="size-3.5 text-primary" />}
                    </span>
                  </button>
                );
              })}
            </div>
            {/* 条数在筛过之后才有意义：一眼知道"筛出来几条 / 本机共几条"。 */}
            <p className="border-t px-3 py-1 text-[10px] text-muted-foreground">
              {t("models.pickerCount", {
                shown: String(visible.length),
                total: String(candidates.length),
              })}
            </p>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
