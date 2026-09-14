import type { ParsedArgs } from "../args";
import { optBool, optString } from "../args";
import { controlRequest } from "../client";
import { resolveDataDir } from "../data-dir";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "fs";

/**
 * `omi logs` —— 读统一应用日志（`<数据目录>/logs/app.log`）。
 *
 * 应用在跑时走控制 socket（内存 + 文件，含本次运行的完整现场）；
 * 应用没运行时直接读文件 —— 这正是「日志必须落盘」的意义：
 * 闪退 / 起不来的场景下 `omi logs` 仍然要能用。
 */

type LogEntry = {
  seq: number;
  ts: number;
  level: "debug" | "info" | "warn" | "error";
  source: string;
  event: string;
  message: string;
  detail?: unknown;
  pid?: number;
};

const LEVEL_COLOR: Record<string, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";
const DIM = "\x1b[90m";

function ts(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatEntry(entry: LogEntry, opts: { color: boolean; verbose: boolean }): string {
  const color = opts.color ? (LEVEL_COLOR[entry.level] ?? "") : "";
  const reset = opts.color ? RESET : "";
  const dim = opts.color ? DIM : "";
  const head = `${dim}${ts(entry.ts)}${reset} ${color}${entry.level.toUpperCase().padEnd(5)}${reset} ${dim}${entry.source}${reset} ${entry.event}`;
  let out = `${head}\n  ${entry.message}`;
  if (opts.verbose && entry.detail !== undefined) {
    try {
      out += `\n  ${dim}${JSON.stringify(entry.detail)}${reset}`;
    } catch {
      // ignore
    }
  }
  return out;
}

/** 应用没运行时：直接读日志文件（与主进程 app-log.ts 同一套 JSONL 格式）。 */
async function readFromFiles(opts: {
  limit: number;
  level?: string;
  source?: string;
}): Promise<{ entries: LogEntry[]; path: string }> {
  const dir = `${resolveDataDir()}/logs`;
  const path = `${dir}/app.log`;
  if (!existsSync(dir)) return { entries: [], path };
  const rank: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  const minRank = opts.level ? (rank[opts.level] ?? 0) : 0;
  const files = readdirSync(dir)
    .filter((n) => n === "app.log" || (n.startsWith("app-") && n.endsWith(".log")))
    .sort()
    .map((n) => `${dir}/${n}`);
  const entries: LogEntry[] = [];
  for (const file of files.reverse()) {
    let lines: string[];
    try {
      lines = readFileSync(file, "utf8").split("\n");
    } catch {
      continue;
    }
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as LogEntry;
        if ((rank[parsed.level] ?? 0) < minRank) continue;
        if (opts.source && parsed.source !== opts.source) continue;
        entries.push(parsed);
      } catch {
        // 半行 / 手工编辑，跳过
      }
    }
    if (entries.length >= opts.limit * 2) break;
  }
  entries.sort((a, b) => b.ts - a.ts || b.seq - a.seq);
  return { entries: entries.slice(0, opts.limit), path };
}

export async function cmdLogs(parsed: ParsedArgs) {
  const limit = Math.max(1, Number(optString(parsed.options, "limit") ?? 50) || 50);
  const level = optString(parsed.options, "level");
  const source = optString(parsed.options, "source");
  const search = optString(parsed.options, "search") ?? optString(parsed.options, "grep");
  const event = optString(parsed.options, "event");
  const json = optBool(parsed.options, "json");
  // 注意：不能用 -v —— 它是全局的 --version（见 src/cli/index.ts）。
  const verbose = optBool(parsed.options, "verbose");
  const clear = optBool(parsed.options, "clear");
  const pathOnly = optBool(parsed.options, "path");
  const follow = optBool(parsed.options, "follow") || optBool(parsed.options, "f");

  if (clear) {
    const r = await controlRequest("logsClear", undefined, 5000);
    if (!r.connected) {
      // 应用没跑：直接删日志文件（保留轮转历史）。
      const file = `${resolveDataDir()}/logs/app.log`;
      if (existsSync(file)) {
        unlinkSync(file);
        console.log(`已清空 ${file}`);
        return;
      }
      console.log("没有可清空的日志文件。");
      return;
    }
    if (!r.ok) {
      console.error(r.error ?? "清空失败");
      process.exitCode = 1;
      return;
    }
    console.log(`已清空统一日志（${r.data?.cleared ?? 0} 条内存记录）。`);
    return;
  }

  const conn = await controlRequest(
    "logs",
    { limit, level, source, search, event, oldestFirst: !follow },
    10_000,
  );
  const fromApp = conn.connected && conn.ok;
  const data = fromApp
    ? (conn.data as { entries: LogEntry[]; path: string })
    : await readFromFiles({ limit, level, source });

  if (pathOnly) {
    console.log(data.path);
    return;
  }

  if (json) {
    console.log(JSON.stringify(data.entries, null, 2));
    return;
  }

  const useColor = process.stdout.isTTY === true;
  console.log(
    `${DIM}统一日志：${data.path}${useColor ? RESET : ""}` +
      (fromApp ? "" : "（应用未运行，读的是磁盘上的记录）"),
  );

  if (data.entries.length === 0) {
    console.log("\n没有匹配的日志。");
    if (!fromApp) console.log("应用没在运行；`omi logs` 只看到上次运行留下的记录。");
    return;
  }

  // 终端阅读顺序：老的在上，新的在下（与文件一致）。
  const ordered = [...data.entries].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  console.log("");
  for (const entry of ordered) console.log(formatEntry(entry, { color: useColor, verbose }));

  if (!follow) return;

  // --follow：轮询文件尾（比控制 socket 更持久，应用重启也不会断）。
  let lastTs = ordered[ordered.length - 1]!.ts;
  let lastSeq = ordered[ordered.length - 1]!.seq;
  console.log(`\n${DIM}—— 跟踪中，Ctrl+C 退出 ——${useColor ? RESET : ""}`);
  for (;;) {
    await new Promise((r) => setTimeout(r, 700));
    const { entries } = await readFromFiles({ limit: 500, level, source });
    const fresh = entries.filter((e) => e.ts > lastTs || (e.ts === lastTs && e.seq > lastSeq));
    if (fresh.length === 0) continue;
    for (const entry of fresh.sort((a, b) => a.ts - b.ts || a.seq - b.seq)) {
      console.log(formatEntry(entry, { color: useColor, verbose }));
      if (entry.ts > lastTs) {
        lastTs = entry.ts;
        lastSeq = entry.seq;
      } else if (entry.ts === lastTs) {
        lastSeq = Math.max(lastSeq, entry.seq);
      }
    }
  }
}
