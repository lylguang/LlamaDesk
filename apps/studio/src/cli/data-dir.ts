import { homedir } from "os";
import { dirname, join } from "path";
import { existsSync, readFileSync, statSync } from "fs";

export const APP_NAME = "LlamaDesk";
export const APP_IDENTIFIER = "com.lylguang.llamadesk";

type VersionInfo = { identifier: string; channel: string };

const BUNDLE_CANDIDATES = [
  "/Applications/LlamaDesk.app",
  join(homedir(), "Applications", "LlamaDesk.app"),
];

/** 打包应用会写 `<bundle>/Contents/Resources/version.json`（含 identifier/channel）。 */
function findAppVersionInfo(): VersionInfo | null {
  for (const bundle of BUNDLE_CANDIDATES) {
    try {
      const p = join(bundle, "Contents", "Resources", "version.json");
      if (!existsSync(p)) continue;
      const v = JSON.parse(readFileSync(p, "utf8")) as Partial<VersionInfo>;
      if (typeof v.identifier === "string" && typeof v.channel === "string") {
        return { identifier: v.identifier, channel: v.channel };
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

export function appBundlePath(): string | null {
  for (const bundle of BUNDLE_CANDIDATES) {
    if (existsSync(bundle)) return bundle;
  }
  return null;
}

/** 数据目录候选：每个 channel 一份（dev / canary / stable）。 */
export type DataDirCandidate = {
  dir: string;
  /** 该目录下有控制 socket（= 大概有实例在跑，重启后可能残留）。 */
  hasSocket: boolean;
  /** omni-studio.db 的修改时间（0 = 没这个库）。越新说明最近用得越多。 */
  dbMtime: number;
};

/**
 * 从候选里挑数据目录（纯函数，便于测试）。
 *
 * 顺序：
 *   1. 有控制 socket 的目录里，库最新的那个 —— 正在运行的实例优先；
 *   2. 否则库最新的那个 —— 文档承诺的"自动探测最近用过的 channel"；
 *   3. 都没有则用默认值。
 *
 * 为什么不能只看安装包：从源码 / `build/` 里跑的 dev、canary 包不在
 * `/Applications` 下，只认安装包会**永远回落到 dev** —— 应用明明在跑，
 * `omi status` 却说"未运行"，`omi logs` 读的也是另一个 channel 的空日志。
 */
export function pickDataDir(candidates: DataDirCandidate[], fallback: string): string {
  const byMtime = (a: DataDirCandidate, b: DataDirCandidate) => b.dbMtime - a.dbMtime;
  const running = candidates.filter((c) => c.hasSocket).sort(byMtime)[0];
  if (running) return running.dir;
  const used = candidates.filter((c) => c.dbMtime > 0).sort(byMtime)[0];
  return used?.dir ?? fallback;
}

const CHANNELS = ["dev", "canary", "stable"];

/** macOS 上按 channel 枚举候选（其余平台返回空，维持原有回退路径）。 */
function channelCandidates(): DataDirCandidate[] {
  if (process.platform !== "darwin") return [];
  const base = join(homedir(), "Library", "Application Support", APP_IDENTIFIER);
  return CHANNELS.map((channel) => {
    const dir = join(base, channel);
    let dbMtime = 0;
    for (const file of ["omni-studio.db", "omni-studio.db-wal"]) {
      try {
        dbMtime = Math.max(dbMtime, statSync(join(dir, file)).mtimeMs);
      } catch {
        // 该 channel 没用过
      }
    }
    return { dir, hasSocket: existsSync(join(dir, "omni-control.sock")), dbMtime };
  });
}

/**
 * 与主进程 `paths.getDataDir` 一致的数据目录（CLI 独立进程版，**同步**）。
 *
 * 用在"还没决定要不要连应用"的地方（读库兜底、写工具配置、日志文件路径）。
 * 顺序：显式 env → 有实例迹象且库最新的 channel → 最近用过的 channel → 安装包 → dev。
 *
 * 注意：socket 文件可能是上次崩溃留下的残留，**单靠它判断不可靠** ——
 * 要连应用请用下面的 `findLiveDataDir()`（真的去 ping）。
 */
export function resolveDataDir(): string {
  if (process.env.OMNI_DATA_DIR) return process.env.OMNI_DATA_DIR;
  if (process.platform === "darwin") {
    const fromChannels = pickDataDir(channelCandidates(), "");
    if (fromChannels) return fromChannels;
    // 机器上有安装包时，它的 channel 才是"这份 CLI 该指的地方"。
    const info = findAppVersionInfo();
    if (info) return join(homedir(), "Library", "Application Support", info.identifier, info.channel);
  }
  // 源码/开发环境下的稳定回退 —— 与主进程 paths.getUserDataDir 的默认一致。
  return join(homedir(), "Library", "Application Support", APP_IDENTIFIER, "dev");
}

/** ping 一个控制 socket（真的连上去，不是看文件在不在）。 */
async function pingSocket(socketPath: string, timeoutMs = 1200): Promise<boolean> {
  if (!existsSync(socketPath)) return false;
  try {
    const res = await fetch("http://control", {
      unix: socketPath,
      method: "POST",
      body: JSON.stringify({ cmd: "ping" }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

let liveCache: { dir: string | null; at: number } | null = null;
/** 一次 CLI 调用里可能连发几个命令，别每次都重新探测。 */
const LIVE_TTL_MS = 1500;

/**
 * 正在运行的那个实例的数据目录（**异步**：逐个候选 socket 真 ping 一遍）。
 *
 * 为什么需要它：`dev` / `canary` / `stable` 各有一份数据目录，而 CLI 可能被从
 * 源码目录调用 —— 只看安装包会永远回落到 dev，应用明明在跑却报"应用未运行"。
 * 残留的 socket 文件也骗不过 ping。
 */
export async function findLiveDataDir(): Promise<string | null> {
  // 显式指定的一律照办（用户知道自己在指哪）。
  if (process.env.OMNI_DATA_DIR) return process.env.OMNI_DATA_DIR;
  if (process.env.OMNI_CONTROL_SOCKET) return dirname(process.env.OMNI_CONTROL_SOCKET);
  if (liveCache && Date.now() - liveCache.at < LIVE_TTL_MS) return liveCache.dir;

  let result: string | null = null;
  // 库最新的先试：正在跑的实例在写 WAL，通常就是它。
  for (const candidate of channelCandidates().sort((a, b) => b.dbMtime - a.dbMtime)) {
    if (await pingSocket(join(candidate.dir, "omni-control.sock"))) {
      result = candidate.dir;
      break;
    }
  }
  liveCache = { dir: result, at: Date.now() };
  return result;
}

/** 能连上的控制 socket 路径；没有活着的实例时返回 null。 */
export async function resolveControlSocket(): Promise<string | null> {
  if (process.env.OMNI_CONTROL_SOCKET) return process.env.OMNI_CONTROL_SOCKET;
  const live = await findLiveDataDir();
  return live ? join(live, "omni-control.sock") : null;
}

/** 与主进程 `paths.controlSocketPath` 相同的 socket 路径。 */
export function controlSocketPath(): string {
  return process.env.OMNI_CONTROL_SOCKET ?? join(resolveDataDir(), "omni-control.sock");
}

/** 仓库根 package.json 的版本（CLI 以源码方式运行时读取）。 */
export function rootVersion(): string | null {
  const candidates = [
    join(import.meta.dir, "..", "..", "..", "..", "package.json"),
    join(import.meta.dir, "..", "..", "package.json"),
  ];
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const pkg = JSON.parse(readFileSync(p, "utf8")) as { version?: unknown };
      if (typeof pkg.version === "string" && pkg.version) return pkg.version;
    } catch {
      // try next
    }
  }
  return null;
}
