/**
 * 主进程侧 GGUF 文件读取器：只读文件头的元数据区（magic + KV），
 * 拿架构 / 层数 / 头数 / 量化档位 / 分片体积，供自动推算启动参数用。
 *
 * 与 `shared/gguf.ts`（纯解析函数，两端共用）的分工：
 *   - 这里负责 IO：增量扩读（元数据区可能 10 MB+，但模型文件 15 GB，绝不一口气读进来）、
 *     分片发现（`name-00003-of-00005.gguf` 一律改读第 1 片）、mtime+size 缓存、失败记日志。
 *
 * 失败不抛错：返回 `{ ok: false, reason, error }`，reason 是封闭枚举，
 * 调用方（UI / 推理服务器启动前检查）按 reason 给提示。
 */
import { open, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseGguf, ggufModelMeta } from "../shared/gguf";
import { firstSplitShardPath } from "./model-scan";
import { logEvent } from "./app-log";

export type GgufFileMeta = {
  meta: ReturnType<typeof ggufModelMeta>;
  version: number;
  /** bigint → number；超出安全整数时给 Number.MAX_SAFE_INTEGER */
  tensorCount: number;
  /** 第一片元数据区（header KV 结束处）的字节数 */
  headerBytes: number;
  /** 实际解析的那个文件（分片时是第一片） */
  filePath: string;
  /** 文件 mtimeMs / size（launch-plan 的缓存指纹用：文件被换掉但名字不变时 mtime 兜住）。 */
  mtimeMs: number;
  size: number;
  /** 所有分片大小之和（权重体积，估显存用） */
  totalFileBytes: number;
  /** 分片数；非分片为 1 */
  shardCount: number;
};

export type GgufReadFailure =
  | "not-found"
  | "not-gguf"
  | "unsupported-version"
  | "too-large"
  | "io"
  | "malformed";

export type GgufReadResult =
  | { ok: true; data: GgufFileMeta }
  | { ok: false; reason: GgufReadFailure; error: string };

/** 元数据区读取上限：超过说明文件异常（词表再大也远小于此），拒绝而不是死循环扩读。 */
const MAX_HEADER_BYTES = 96 * 1024 * 1024;
const INITIAL_READ_BYTES = 1024 * 1024; // 1 MiB 起步

/**
 * 分批 GGUF 的分片命名：`GLM-5.2-UD-Q3_K_M-00003-of-00009.gguf`。
 * 与 model-scan.ts 里的规则一致（那边的是私有常量），这里自己持有一份，
 * 因为除了「第一片路径」还需要「同组所有分片」的枚举。
 */
const SPLIT_GGUF_RE = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;

type CacheEntry = { data: GgufFileMeta; mtimeMs: number; size: number };
const cache = new Map<string, CacheEntry>();

export function clearGgufMetaCache(): void {
  cache.clear();
}

async function statFile(p: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const s = await stat(p);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

/** 增量扩读：不够就按 needBytes（至少翻倍）再读，直到成功 / 超上限 / 读到文件尾。 */
async function readGgufFile(
  filePath: string,
  size: number,
): Promise<
  | { ok: true; version: number; tensorCount: bigint; headerBytes: number; kv: Parameters<typeof ggufModelMeta>[0]; arrayLengths: Record<string, number> }
  | { ok: false; reason: GgufReadFailure; error: string }
> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(filePath, "r");
    let target = INITIAL_READ_BYTES;
    let last: number | null = null;
    for (let attempt = 0; attempt < 24; attempt++) {
      const buf = new Uint8Array(target);
      const { bytesRead } = await handle.read(buf, 0, target, 0);
      if (last !== null && bytesRead <= last) {
        // 扩读没拿到新字节：文件其实就这么长，下面的 parse 会给出终局原因
        target = last;
      }
      last = bytesRead;
      const res = parseGguf(buf.subarray(0, bytesRead));
      if (res.ok) {
        return {
          ok: true,
          version: res.version,
          tensorCount: res.tensorCount,
          headerBytes: res.headerBytes,
          kv: res.kv,
          arrayLengths: res.arrayLengths,
        };
      }
      if (res.error === "truncated") {
        const need = res.needBytes ?? bytesRead + 1;
        if (need > MAX_HEADER_BYTES) {
          return { ok: false, reason: "too-large", error: `元数据区超过 ${MAX_HEADER_BYTES} 字节上限` };
        }
        // 需要更多字节（need 含解析器的保守余量）：窗口提到 need，至少翻倍，但不超过文件实际大小。
        // 注意不能拿 need 去和文件大小比来判定「读到文件尾」——need 是估算的下界，
        // 可能超出真实文件长（词表撑大的头部），那样会把完整文件误判成损坏。
        target = Math.min(Math.max(need, target * 2), size);
        continue;
      }
      // not-gguf / unsupported-version / malformed：只有读满整个文件（文件 ≤ 窗口）时才可信；
      // 文件还有剩余字节时先扩读（10 MB 的词表会把真正的版本字段推到第一个窗口之外）。
      if (bytesRead >= size) {
        return { ok: false, reason: res.error, error: `GGUF 解析失败（${res.error}）` };
      }
      const next = Math.min(Math.max(bytesRead + 1, target * 2), size);
      if (next >= bytesRead) {
        return {
          ok: false,
          reason: res.error,
          error: res.error === "malformed"
            ? "元数据区含无法解析的内容（文件可能损坏）"
            : `GGUF 解析失败（${res.error}）`,
        };
      }
      target = next;
    }
    return { ok: false, reason: "malformed", error: "元数据区读取重试次数过多" };
  } catch (e) {
    return { ok: false, reason: "io", error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/** 同组所有分片（按命名匹配当前文件）；非分片返回 [自己]。 */
async function findShards(filePath: string): Promise<string[]> {
  const m = SPLIT_GGUF_RE.exec(basename(filePath));
  if (!m || m[1] === undefined) return [filePath];
  const dir = resolve(filePath, "..");
  const shardRe = new RegExp(`^${m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d{5}-of-\\d{5}\\.gguf$`, "i");
  try {
    const entries = await readdir(dir);
    const shards = entries.filter((e) => shardRe.test(e)).map((e) => join(dir, e));
    return shards.length > 0 ? shards : [filePath];
  } catch {
    return [filePath];
  }
}

export async function readGgufMeta(path: string): Promise<GgufReadResult> {
  let targetPath = path;
  // 传进来的是第 N 片（N>1）时改去解析第 1 片（只有它带完整元数据）；
  // 第 1 片不存在（下载不完整）就原样解析传入的文件。
  const first = firstSplitShardPath(targetPath);
  if (first !== null) targetPath = first;
  const absPath = resolve(targetPath);

  const st = await statFile(absPath);
  if (st === null) {
    const result: GgufReadResult = {
      ok: false,
      reason: "not-found",
      error: `文件不存在：${basename(absPath)}`,
    };
    logEvent({
      level: "warn",
      source: "download",
      event: "gguf.meta.read_failed",
      message: `GGUF 元数据读取失败（not-found）：${basename(absPath)}`,
      detail: { reason: "not-found", file: basename(absPath) },
    });
    return result;
  }

  const cached = cache.get(absPath);
  if (cached !== undefined && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return { ok: true, data: cached.data };
  }

  const shards = await findShards(absPath);
  let totalFileBytes = 0;
  for (const s of shards) {
    const ss = await statFile(s);
    totalFileBytes += ss?.size ?? 0;
  }

  const res = await readGgufFile(absPath, st.size);
  if (!res.ok) {
    logEvent({
      level: "warn",
      source: "download",
      event: "gguf.meta.read_failed",
      message: `GGUF 元数据读取失败（${res.reason}）：${basename(absPath)} — ${res.error}`,
      detail: { reason: res.reason, file: basename(absPath) },
    });
    return { ok: false, reason: res.reason, error: res.error };
  }

  const data: GgufFileMeta = {
    meta: ggufModelMeta(res.kv, res.arrayLengths),
    version: res.version,
    tensorCount:
      res.tensorCount > BigInt(Number.MAX_SAFE_INTEGER)
        ? Number.MAX_SAFE_INTEGER
        : Number(res.tensorCount),
    headerBytes: res.headerBytes,
    filePath: absPath,
    mtimeMs: st.mtimeMs,
    size: st.size,
    totalFileBytes,
    shardCount: shards.length,
  };
  cache.set(absPath, { data, mtimeMs: st.mtimeMs, size: st.size });
  return { ok: true, data };
}
