import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon, ChevronRightIcon, Trash2Icon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { useT } from "@stores/ui-lang";
import { cn } from "@lib/utils";
import type { AppLogEntry, AppLogLevel } from "../../bun/app-log";

/**
 * 应用日志（`<数据目录>/logs/app.log`）的查看器。
 *
 * 在这之前，日志只能在终端里 `omi logs` 看 —— 出问题的往往是刚点过按钮的普通用户，
 * 让他开终端、翻文件系统就等于没法排查。这里把同一份数据搬到界面上：
 *
 * - 级别 / 搜索 / 最近 N 条都交给主进程过滤（日志文件可以很大，整份搬到 webview 没意义）；
 * - 跟随最新每秒轮询，只取「比基线新」的内存记录（`memoryOnly`）—— 回落到磁盘的话
 *   主进程每秒都要整份读 2MB 的日志文件；
 * - 轮转文件（`app-*.log`）在同一个下拉里切换，不用再去文件系统里翻。
 */

const LIVE = "__live__";
const LEVELS: (AppLogLevel | "all")[] = ["all", "debug", "info", "warn", "error"];

/** 等级 chip 的配色：错误红、警告黄、信息蓝、调试灰。 */
const LEVEL_TONE: Record<AppLogLevel, string> = {
  debug: "bg-muted text-muted-foreground",
  info: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  warn: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  error: "bg-destructive/15 text-destructive",
};

/** `HH:mm:ss.mmm` —— 日志的定位精度到毫秒，日期放进 title。 */
function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 轮转文件名里的时间戳（`:` `.` 在轮转时被换成了 `-`）→ 本地时间标签。 */
function rotatedLabel(name: string): string {
  const m = /^app-(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.log$/.exec(name);
  if (!m) return name;
  const epoch = Date.parse(`${m[1]}:${m[2]}:${m[3]}.${m[4]}Z`);
  if (Number.isNaN(epoch)) return name;
  const d = new Date(epoch);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function baseName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

function entryKey(entry: AppLogEntry): string {
  // seq 是进程内递增的，pid 一起才是全局唯一（跨重启的同一个 seq 不是一条记录）。
  return `${entry.pid}:${entry.seq}`;
}

export function AppLogView({ limit }: { limit: number }) {
  const t = useT();
  const [level, setLevel] = useState<AppLogLevel | "all">("all");
  const [search, setSearch] = useState("");
  /** 当前看的文件：null = app.log（实时那本），否则是轮转出来的历史文件。 */
  const [file, setFile] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const live = file == null;
  const needle = search.trim();

  // 轮转文件清单：轮转是「写到 2MB」才发生的，15 秒刷一次足够反映新文件。
  const { data: info } = useQuery({
    queryKey: ["app-log-info"],
    queryFn: () => rpcClient.getAppLogInfo(),
    refetchInterval: 15_000,
  });
  // appLogFiles() 按文件名升序（= 时间升序），界面上新文件在前。
  const rotatedFiles = useMemo(
    () => [...(info?.files ?? [])].filter((f) => f.rotated).reverse(),
    [info],
  );

  // 选中的轮转文件被轮转清理删掉后，落回实时那本：否则会停在一个永远读不到的文件上。
  useEffect(() => {
    if (file && info && !info.files.some((f) => baseName(f.path) === file)) setFile(null);
  }, [file, info]);

  // 查询签名变化 = 换了数据源/过滤条件：累积窗口与轮询基线必须一起重置，
  // 否则新过滤器会先被旧的累积结果「污染」一轮。epoch 由「清空」按钮推动。
  const [epoch, setEpoch] = useState(0);
  const signature = `${file ?? LIVE}|${level}|${needle}|${limit}|${epoch}`;
  const accumulated = useRef(new Map<string, AppLogEntry>());
  const since = useRef<number | null>(null);
  const currentSignature = useRef(signature);

  const {
    data: entries,
    isError,
    isFetching,
  } = useQuery({
    queryKey: ["app-logs", file ?? LIVE, level, needle, limit, epoch],
    queryFn: async () => {
      const atStart = signature;
      if (currentSignature.current !== atStart) {
        currentSignature.current = atStart;
        accumulated.current.clear();
        since.current = null;
      }
      // 基线之前已看过的记录不再重复搬；memoryOnly 让主进程只扫内存环，
      // 不然每秒一次轮询都要把日志文件整份读出来解析。
      const polling = since.current != null;
      // 请求发起时刻就是基线的一部分：它之后写下的记录即使这次没赶上，
      // 下一次轮询也会按 >= 捞回来（用响应时刻会把请求途中写的记录跳过）。
      const startedAt = Date.now();
      const res = await rpcClient.getAppLogs({
        level: level === "all" ? undefined : level,
        search: needle || undefined,
        limit,
        oldestFirst: true,
        ...(file ? { file } : polling ? { since: since.current!, memoryOnly: true } : {}),
      });
      if (currentSignature.current !== atStart) return [...accumulated.current.values()];
      for (const entry of res.entries) {
        const key = entryKey(entry);
        if (accumulated.current.has(key)) accumulated.current.delete(key);
        accumulated.current.set(key, entry);
      }
      // Map 保持插入顺序 = 时间顺序，超窗的从最老的开始丢。
      while (accumulated.current.size > limit) {
        const oldest = accumulated.current.keys().next().value;
        if (oldest == null) break;
        accumulated.current.delete(oldest);
      }
      const newest = res.entries.reduce((max, entry) => Math.max(max, entry.ts), 0);
      since.current = Math.max(since.current ?? 0, startedAt, newest);
      return [...accumulated.current.values()];
    },
    refetchInterval: follow && live ? 1000 : false,
    refetchOnWindowFocus: false,
  });

  const rows = useMemo(() => entries ?? [], [entries]);

  // 跟随最新时自动滚到底；用户滚上去看历史时不要再把他拽回来。
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickyBottom = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && follow && live && stickyBottom.current) el.scrollTop = el.scrollHeight;
  }, [rows, follow, live]);

  const toggleDetail = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const clear = async () => {
    await rpcClient.clearAppLogs();
    setExpanded(new Set());
    // 换一个查询 key：累积窗口与轮询基线跟着重来（主进程那边内存与文件都清了）。
    setEpoch((prev) => prev + 1);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2" data-slot="app-log-controls">
        <span className="text-[11px] text-muted-foreground" title={t("console.levelHint")}>
          {t("console.level")}
        </span>
        <div className="flex items-center gap-1">
          {LEVELS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={level === value}
              onClick={() => setLevel(value)}
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors",
                level === value
                  ? "bg-primary/10 text-primary"
                  : "bg-muted text-muted-foreground hover:text-foreground",
              )}
            >
              {t(`console.level.${value}`)}
            </button>
          ))}
        </div>

        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("console.searchPlaceholder")}
          aria-label={t("console.searchPlaceholder")}
          className="h-7 max-w-64 text-xs"
        />

        <Select value={file ?? LIVE} onValueChange={(value) => setFile(value === LIVE ? null : value)}>
          <SelectTrigger size="sm" className="h-7 min-w-44 max-w-72 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={LIVE}>{t("console.logFileLive")}</SelectItem>
            {rotatedFiles.map((f) => {
              const name = baseName(f.path);
              return (
                <SelectItem key={f.path} value={name}>
                  {rotatedLabel(name)}
                  <span className="ml-2 text-[10px] text-muted-foreground">
                    {formatSize(f.size)}
                  </span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>

        <div className="flex-1" />

        <span className="text-[11px] text-muted-foreground tabular-nums">
          {t("console.entriesCount", { n: String(rows.length) })}
          {isFetching && live && follow && (
            <span className="ml-1 inline-block size-1.5 animate-pulse rounded-full bg-emerald-500 align-middle" />
          )}
        </span>

        {/* 跟随最新只对实时文件有意义：轮转文件是静止的历史 */}
        {live && (
          <Button
            variant={follow ? "default" : "outline"}
            size="xs"
            aria-pressed={follow}
            onClick={() => setFollow((prev) => !prev)}
          >
            {t(follow ? "console.following" : "console.follow")}
          </Button>
        )}
        {live && (
          <Button variant="outline" size="xs" tooltip={t("console.clear")} onClick={clear}>
            <Trash2Icon data-icon="inline-start" />
            {t("console.clear")}
          </Button>
        )}
      </div>

      <div
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (el) stickyBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="min-h-0 flex-1 overflow-auto rounded-lg border"
        data-slot="app-log-table"
      >
        <table className="w-full border-collapse text-left text-xs">
          <thead className="sticky top-0 z-10 bg-background/95 backdrop-blur">
            <tr className="border-b text-[10px] text-muted-foreground">
              <th className="w-24 px-2 py-1.5 font-medium">{t("console.colTime")}</th>
              <th className="w-16 px-2 py-1.5 font-medium">{t("console.colLevel")}</th>
              <th className="w-24 px-2 py-1.5 font-medium">{t("console.colSource")}</th>
              <th className="px-2 py-1.5 font-medium">{t("console.colEvent")}</th>
              <th className="px-2 py-1.5 font-medium">{t("console.colMessage")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((entry) => {
              const key = entryKey(entry);
              const open = expanded.has(key);
              return (
                <Fragment key={key}>
                  <tr
                    className="cursor-pointer border-b border-border/50 align-top hover:bg-muted/40"
                    onClick={() => toggleDetail(key)}
                  >
                    <td className="px-2 py-1 whitespace-nowrap font-mono text-[10px] text-muted-foreground tabular-nums">
                      <span className="inline-flex items-center gap-1">
                        {open ? (
                          <ChevronDownIcon className="size-3 shrink-0" />
                        ) : (
                          <ChevronRightIcon className="size-3 shrink-0" />
                        )}
                        <span title={new Date(entry.ts).toISOString()}>{formatTime(entry.ts)}</span>
                      </span>
                    </td>
                    <td className="px-2 py-1">
                      <span
                        className={cn(
                          "rounded-full px-1.5 py-0.5 text-[9px] font-medium",
                          LEVEL_TONE[entry.level],
                        )}
                      >
                        {t(`console.level.${entry.level}`)}
                      </span>
                    </td>
                    <td className="px-2 py-1 font-mono text-[10px] text-muted-foreground">
                      {entry.source}
                    </td>
                    <td className="px-2 py-1 font-mono text-[11px] wrap-anywhere">{entry.event}</td>
                    <td className="px-2 py-1 wrap-anywhere">{entry.message}</td>
                  </tr>
                  {open && (
                    <tr className="border-b border-border/50 bg-muted/20">
                      <td colSpan={5} className="px-2 py-1">
                        <pre className="max-h-64 overflow-auto text-[10px] whitespace-pre-wrap">
                          {entry.detail == null
                            ? t("console.noDetail")
                            : JSON.stringify(entry.detail, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            {isError ? t("console.appLogUnreadable") : t("console.noLogs")}
          </p>
        )}
      </div>
    </div>
  );
}
