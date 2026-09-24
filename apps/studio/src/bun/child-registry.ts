/**
 * 受管子进程登记册 —— 解决「父进程被 SIGKILL 后子进程带显存活下来」的孤儿问题。
 *
 * 现有的 `proc.ts` 只覆盖**协作式关闭**（`killProcessTree` 走进程组），
 * 但当主进程被强杀（SIGKILL / 任务管理器 / 崩溃 / 断网断电）时那段代码根本不会跑，
 * llama.cpp / vLLM / SGLang / MLX / whisper / OCR 就会带着几 GB 显存变成孤儿，
 * 下次启动端口被占、显存被吃。
 *
 * 这里的做法：每个受管子进程启动时把 {pid, pgid, exe, ...} 落盘到
 * `<dataDir>/child-pids.json`；下一次应用启动时 `reapRecordedChildren()`
 * 逐条**先核对身份再杀**，把上次遗留的进程清掉。
 *
 * 安全边界是**身份核对**：pid 会被系统复用，几天后同一个 pid 很可能是用户自己的别的程序。
 * 所以杀之前必须确认「这个 pid 还是当初那个进程」，核对不上一律跳过（宁可漏杀不能误杀）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { basename, join } from "path";

import { getDataDir } from "./paths";
import { logEvent } from "./app-log";

export type ChildRecord = {
  pid: number;
  /** 进程组 id（detached 启动时等于 pid），杀的时候用 -pgid。 */
  pgid: number;
  /** 可执行文件路径或名字，回收前用来核对身份，防 pid 复用误杀。 */
  exe: string;
  /** 记录时间，毫秒时间戳。 */
  startedAt: number;
  /** 谁启动的，便于排查：如 "llama.cpp" / "vllm" / "whisper"。 */
  owner: string;
};

/** 落盘文件名（固定，`<dataDir>/child-pids.json`）。 */
const FILE_NAME = "child-pids.json";
/** 签名前缀，用来区分"是我们自己写的合法 JSON"与"别的东西占了同一路径"。 */
const MAGIC = "omni-studio-child-pids-v1";

function fileLocation(): string {
  return join(getDataDir(), FILE_NAME);
}

// ---------------------------------------------------------------------------
// 读 / 写（原子写：先写临时文件再 rename，被 SIGKILL 也不会留下半个文件）
// ---------------------------------------------------------------------------

/**
 * 读全部记录。文件不存在 / JSON 坏了 / schema 不符一律返回空数组，**不抛**
 * （fail-open：丢掉几条记录远好过应用起不来）。
 */
export function listRecordedChildren(): ChildRecord[] {
  try {
    const raw = readFileSync(fileLocation(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parseChildren(parsed);
  } catch {
    return [];
  }
}

function parseChildren(value: unknown): ChildRecord[] {
  if (typeof value !== "object" || value === null) return [];
  const obj = value as { magic?: unknown; children?: unknown };
  if (obj.magic !== MAGIC) return [];
  if (!Array.isArray(obj.children)) return [];
  const out: ChildRecord[] = [];
  for (const entry of obj.children) {
    const rec = normalizeRecord(entry);
    if (rec) out.push(rec);
  }
  return out;
}

function normalizeRecord(value: unknown): ChildRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  const { pid, pgid, exe, startedAt, owner } = obj;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof pgid !== "number" || !Number.isInteger(pgid) || pgid <= 0) return null;
  if (typeof exe !== "string" || exe.length === 0) return null;
  const started = typeof startedAt === "number" ? startedAt : Date.now();
  const own = typeof owner === "string" ? owner : "unknown";
  return { pid, pgid, exe, startedAt: started, owner: own };
}

/**
 * 把当前记录原子写回磁盘：写到同目录的临时文件再 rename —— 被 SIGKILL 时
 * 不会留下半个文件（rename 是原子的）。目录不存在时先建。
 */
function persist(records: ChildRecord[]): void {
  const dir = getDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const target = fileLocation();
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ magic: MAGIC, children: records }, null, 2), "utf8");
  renameSync(tmp, target);
}

// 进程内的读-改-写：Node/Bun 单线程事件循环里同步段不会被抢占，
// 用 sync 版即可保证「读列表 → 改 → 原子写回」三步原子，无需额外锁。
function recordSync(rec: ChildRecord): void {
  const records = listRecordedChildren();
  persist(records.filter((r) => r.pid !== rec.pid).concat(rec));
}

function forgetSync(pid: number): void {
  const records = listRecordedChildren();
  const next = records.filter((r) => r.pid !== pid);
  if (next.length === records.length) return; // 本来就没记录，别白白重写
  persist(next);
}

// ---------------------------------------------------------------------------
// 增 / 删
// ---------------------------------------------------------------------------

/**
 * 登记一个受管子进程（同步、原子）。
 * 记录失败不能影响主流程：内部 try/catch，失败只 logEvent。
 */
export function recordChild(rec: ChildRecord): void {
  try {
    recordSync(rec);
  } catch (e) {
    logEvent({
      level: "warn",
      source: "app",
      event: "child_registry.record_failed",
      message: `登记子进程失败（pid=${rec.pid}）`,
      detail: {
        pid: rec.pid,
        owner: rec.owner,
        error: e instanceof Error ? e.message : String(e),
      },
    });
  }
}

/**
 * 忘记一个子进程（它被正常停止 / 自行退出后调用）。
 * 同样 try/catch：清理失败只 logEvent，不抛。
 */
export function forgetChild(pid: number): void {
  try {
    forgetSync(pid);
  } catch (e) {
    logEvent({
      level: "warn",
      source: "app",
      event: "child_registry.forget_failed",
      message: `移除子进程记录失败（pid=${pid}）`,
      detail: { pid, error: e instanceof Error ? e.message : String(e) },
    });
  }
}

// ---------------------------------------------------------------------------
// 身份核对 + 发信号（默认实现，测试可注入假实现）
// ---------------------------------------------------------------------------

/**
 * 取某 pid 的命令行/可执行文件名：
 *  - Linux：读 `/proc/<pid>/cmdline`（null 分隔），返回第一段（argv[0]）
 *  - macOS：`ps -p <pid> -o comm=`，返回输出
 *  - 进程不存在 / 读不到 → 返回 null
 */
export function readCmdline(pid: number): string | null {
  if (process.platform === "darwin") {
    try {
      const out = Bun.spawnSync(["ps", "-p", String(pid), "-o", "comm="], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const code = out.exitCode;
      const text = out.stdout ? out.stdout.toString().trim() : "";
      if (code !== 0 || text.length === 0) return null;
      return text;
    } catch {
      return null;
    }
  }
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    const argv = raw.split("\0").filter((s) => s.length > 0);
    const first = argv[0];
    return first === undefined ? null : first;
  } catch {
    return null;
  }
}

/** 给进程组发信号（pgid 传负值 -pgid）。ESRCH（进程已没了）不算错误。 */
export function signalGroup(pgid: number, signal: "SIGTERM" | "SIGKILL"): void {
  process.kill(-pgid, signal);
}

/**
 * 身份核对：记录的 `exe`（或其 basename）是否出现在当前该 pid 的 cmdline 里。
 * 返回 false = 无法确认是同一个进程（含进程已不存在）。
 */
export function identityMatches(exe: string, cmdline: string | null): boolean {
  if (cmdline === null) return false;
  const needle = basename(exe);
  const haystack = cmdline.toLowerCase();
  if (haystack.includes(needle.toLowerCase())) return true;
  // cmdline 第一段可能只带 basename，而记录的 exe 是全路径 —— 再按完整路径兜一层
  return exe.length > 0 && haystack.includes(exe.toLowerCase());
}

// ---------------------------------------------------------------------------
// 启动时扫尾
// ---------------------------------------------------------------------------

export type ReapOptions = {
  /** 覆盖身份核对（测试用）。 */
  readCmdline?: (pid: number) => string | null;
  /** 覆盖发信号（测试用）。 */
  signalGroup?: (pgid: number, signal: "SIGTERM" | "SIGKILL") => void;
  /** 覆盖等一小段时间（测试用，传 0 跳过）。 */
  sleep?: (ms: number) => Promise<void>;
  /** 覆盖落盘（测试用）。 */
  forget?: (pid: number) => void;
};

/**
 * 杀掉上次遗留的受管子进程，返回实际回收（确认已死/已发信号）的个数。
 *
 * 规则（安全优先）：
 *  - 进程不存在（cmdline 读不到）→ 直接从记录清掉，不 kill，计 stale；
 *  - 身份核对不过（cmdline 不是当初那个 exe）→ 跳过 + warn 日志，计 skipped；
 *  - 核对通过 → SIGTERM 整个进程组，等一小段时间还活着再 SIGKILL，计 reaped。
 */
export async function reapRecordedChildren(opts: ReapOptions = {}): Promise<number> {
  const read = opts.readCmdline ?? readCmdline;
  const signal = opts.signalGroup ?? signalGroup;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const forget = opts.forget ?? forgetChild;

  const records = listRecordedChildren();
  if (records.length === 0) return 0;

  let reaped = 0;
  let skipped = 0;
  let stale = 0;

  for (const rec of records) {
    const cmdline = read(rec.pid);

    // 进程已不存在：清掉记录即可，不 kill。
    if (cmdline === null) {
      stale += 1;
      forget(rec.pid);
      continue;
    }

    // 身份核对：核对不上宁可跳过也不能误杀。
    if (!identityMatches(rec.exe, cmdline)) {
      skipped += 1;
      forget(rec.pid);
      logEvent({
        level: "warn",
        source: "app",
        event: "child_reap.identity_mismatch",
        message: `pid ${rec.pid} 已不是当初的 ${rec.exe}，跳过回收（防 pid 复用误杀）`,
        detail: { pid: rec.pid, pgid: rec.pgid, owner: rec.owner, exe: rec.exe, cmdline },
      });
      continue;
    }

    // 核对通过：先 SIGTERM 整个进程组。
    try {
      signal(rec.pgid, "SIGTERM");
    } catch {
      // ESRCH：进程组已没了，等同已回收。
    }

    await sleep(1500);

    // 还活着再 SIGKILL。
    const stillThere = read(rec.pid);
    if (stillThere !== null) {
      try {
        signal(rec.pgid, "SIGKILL");
      } catch {
        // ESRCH
      }
    }

    reaped += 1;
    forget(rec.pid);
  }

  logEvent({
    level: "info",
    source: "app",
    event: "child_reap.done",
    message: `启动扫尾：回收 ${reaped}，跳过 ${skipped}，过期 ${stale}（共 ${records.length}）`,
    detail: { reaped, skipped, stale, total: records.length },
  });

  return reaped;
}

// ---------------------------------------------------------------------------
// 测试辅助（仅供测试，运行时不需要）
// ---------------------------------------------------------------------------

export function __childRegistryFileForTest(): string {
  return fileLocation();
}
