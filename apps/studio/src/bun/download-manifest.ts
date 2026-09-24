/**
 * 下载完整性 manifest + 取消标记 —— 「这个模型到底下完了没有」的 ground truth。
 *
 * 背景：此前判断「已在设备上」靠的是扫磁盘 + 比文件名，缺一个「这次下载本来
 * 应该取哪些文件、各多大」的记录（AGENTS.md 记录过 `installedFilesForRepo`
 * 丢 7.5 GB / ~16 GB 权重的真机事故）。本模块只负责**独立的存储层 + 纯逻辑**：
 *
 *   - manifest：`<dataDir>/downloads/manifests/<safeRepoId>__<safeVariant>.json`
 *     —— 开始下载时记下应取文件列表与声称大小；下载完和扫描时比对磁盘。
 *   - 取消标记：`<dataDir>/downloads/cancelled/<safeRepoId>__<safeVariant>.json`
 *     —— 存在性本身就是信号（内容只是给人看的）。
 *
 * 语义（接入下载流程前必须保持，勿自由发挥）：
 *   1. 写入一律原子（临时文件 + `rename`）—— SIGKILL 时不能留下半个 JSON。
 *   2. manifest 读失败 → fail-open（返回 `null`），调用方回落到磁盘扫描；
 *      这样兼容手动拷进来的模型和历史下载。
 *   3. 取消标记读失败 → fail-closed（文件在就算数）。
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { basename, join, resolve } from "path";
import { logEvent } from "./app-log";
import { getDataDir } from "./paths";
import { isInsideDir, safeJoin } from "./path-safety";
import { safeRepoId } from "../shared/modelscope";

export const DOWNLOAD_MANIFEST_SCHEMA = 1;

export type ExpectedFile = {
  /** 相对仓库根目录的路径 */
  path: string;
  /** 来源声称的字节数；未知给 null */
  size: number | null;
};

export type DownloadManifest = {
  schema: number;
  repoId: string;
  /** 量化档位 / 变体，没有就空字符串 */
  variant: string;
  createdAt: number;
  files: ExpectedFile[];
};

export type ManifestCheck = {
  complete: boolean;
  /** manifest 里有、磁盘上没有的 */
  missing: string[];
  /** 磁盘上有但字节数比 manifest 声称的小的（下了一半） */
  short: Array<{ path: string; expected: number; actual: number }>;
};

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

function downloadsRoot(): string {
  return getDataDir("downloads");
}

function manifestsDir(): string {
  return join(downloadsRoot(), "manifests");
}

function cancelledDir(): string {
  return join(downloadsRoot(), "cancelled");
}

/** variant 为空时用 `_` 占位，保持 `<repo>__<variant>` 结构不变。 */
function encodedVariant(variant: string): string {
  return variant === "" ? "_" : safeRepoId(variant);
}

/**
 * 目标文件路径；非法返回 null（`..` / 绝对路径 / 分隔符 / NUL 一律拒绝）。
 * repoId 经 `safeRepoId` 编码（与下载目录同一规则，`org/repo` → `org__repo`），
 * variant 同样编码（为空用 `_` 占位）；最后再过一道 `safeJoin` + 包含检查兜底。
 */
function recordPath(dir: string, repoId: string, variant: string): string | null {
  if (typeof repoId !== "string" || repoId.length === 0) return null;
  if (typeof variant !== "string") return null;
  // 含 `..` 的输入（`../../evil`）直接拒绝，不靠编码后的偶然结果
  if (repoId.includes("..") || variant.includes("..")) return null;
  const base = resolve(dir);
  const target = safeJoin(base, `${safeRepoId(repoId)}__${encodedVariant(variant)}.json`);
  if (target == null || !isInsideDir(base, target)) return null;
  return target;
}

// ---------------------------------------------------------------------------
// 原子写
// ---------------------------------------------------------------------------

/**
 * 临时文件 + `rename`。临时文件放在目标同目录下（同卷），
 * 前缀带进程 pid 避免并发实例互相踩。
 */
function atomicWriteJson(target: string, body: string): boolean {
  const dir = resolve(target.slice(0, target.lastIndexOf("/") + 1));
  const name = basename(target) || "unknown";
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, target);
    return true;
  } catch (e) {
    logEvent({
      level: "warn",
      source: "download",
      event: "download.manifest.write_failed",
      message: `原子写入失败: ${name}`,
      detail: { target, name, error: e instanceof Error ? e.message : String(e) },
    });
    try {
      for (const entry of readdirSync(dir)) {
        if (entry.startsWith(`.${process.pid}-`)) {
          try {
            rmSync(join(dir, entry), { force: true });
          } catch {
            // 清理失败不影响主流程
          }
        }
      }
    } catch {
      // 忽略
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

export function writeDownloadManifest(
  m: Omit<DownloadManifest, "schema" | "createdAt">,
): boolean {
  const dir = manifestsDir();
  const target = recordPath(dir, m.repoId, m.variant);
  if (target == null) {
    logEvent({
      level: "warn",
      source: "download",
      event: "download.manifest.write_failed",
      message: `拒绝写入 manifest（非法 repoId/variant）: ${String(m.repoId)}/${String(m.variant)}`,
      detail: { repoId: String(m.repoId), variant: String(m.variant) },
    });
    return false;
  }
  const body = JSON.stringify({ schema: DOWNLOAD_MANIFEST_SCHEMA, createdAt: Date.now(), ...m });
  const ok = atomicWriteJson(target, body);
  if (!ok) {
    logEvent({
      level: "warn",
      source: "download",
      event: "download.manifest.write_failed",
      message: `manifest 写入失败: ${m.repoId} / ${m.variant}`,
      detail: { repoId: m.repoId, variant: m.variant, files: m.files.length },
    });
  }
  return ok;
}

function parseManifest(raw: string): DownloadManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed == null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.schema !== "number" || obj.schema !== DOWNLOAD_MANIFEST_SCHEMA) return null;
  if (typeof obj.repoId !== "string" || obj.repoId.length === 0) return null;
  if (typeof obj.variant !== "string") return null;
  if (typeof obj.createdAt !== "number" || !Number.isFinite(obj.createdAt)) return null;
  if (!Array.isArray(obj.files)) return null;
  const files: ExpectedFile[] = [];
  for (const item of obj.files) {
    if (typeof item !== "object" || item == null) return null;
    const f = item as Record<string, unknown>;
    if (typeof f.path !== "string" || f.path.length === 0) return null;
    const size = f.size === null ? null : f.size;
    if (size !== null && (typeof size !== "number" || !Number.isFinite(size) || size < 0)) {
      return null;
    }
    files.push({ path: f.path, size });
  }
  return {
    schema: DOWNLOAD_MANIFEST_SCHEMA,
    repoId: obj.repoId,
    variant: obj.variant,
    createdAt: obj.createdAt,
    files,
  };
}

export function readDownloadManifest(repoId: string, variant: string): DownloadManifest | null {
  const dir = manifestsDir();
  const target = recordPath(dir, repoId, variant);
  if (target == null) return null;
  let raw: string;
  try {
    raw = readFileSync(target, "utf8");
  } catch {
    return null; // fail-open：文件不存在 → 调用方回落到磁盘扫描
  }
  const manifest = parseManifest(raw);
  if (manifest == null) {
    logEvent({
      level: "warn",
      source: "download",
      event: "download.manifest.corrupt",
      message: `manifest 损坏或 schema 不符，回落到磁盘扫描: ${repoId} / ${variant}`,
      detail: { repoId, variant },
    });
    return null;
  }
  return manifest;
}

export function removeDownloadManifest(repoId: string, variant: string): boolean {
  const dir = manifestsDir();
  const target = recordPath(dir, repoId, variant);
  if (target == null) return false;
  try {
    rmSync(target, { force: true });
    return true;
  } catch {
    logEvent({
      level: "warn",
      source: "download",
      event: "download.manifest.write_failed",
      message: `manifest 删除失败: ${repoId} / ${variant}`,
      detail: { repoId, variant },
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// 取消标记
// ---------------------------------------------------------------------------

export function markDownloadCancelled(repoId: string, variant: string, note?: string): boolean {
  const dir = cancelledDir();
  const target = recordPath(dir, repoId, variant);
  if (target == null) {
    logEvent({
      level: "warn",
      source: "download",
      event: "download.manifest.write_failed",
      message: `拒绝写取消标记（非法 repoId/variant）: ${String(repoId)}/${String(variant)}`,
      detail: { repoId: String(repoId), variant: String(variant) },
    });
    return false;
  }
  const body = JSON.stringify({ repoId, variant, note: note ?? null, at: Date.now() });
  const ok = atomicWriteJson(target, body);
  if (!ok) {
    logEvent({
      level: "warn",
      source: "download",
      event: "download.manifest.write_failed",
      message: `取消标记写入失败: ${repoId} / ${variant}`,
      detail: { repoId, variant },
    });
  }
  return ok;
}

/**
 * fail-closed：只要文件存在就算取消（内容解析不出来也返回 `true`）——
 * 存在性本身就是信号，内容是给人看的。仅当 repoId/variant 非法（无法构造路径）
 * 时返回 `false`。
 */
export function isDownloadCancelled(repoId: string, variant: string): boolean {
  const dir = cancelledDir();
  const target = recordPath(dir, repoId, variant);
  if (target == null) return false;
  try {
    readFileSync(target, "utf8");
    return true; // fail-closed：文件存在即算数
  } catch {
    return false; // 文件不存在
  }
}

export function clearDownloadCancelled(repoId: string, variant: string): boolean {
  const dir = cancelledDir();
  const target = recordPath(dir, repoId, variant);
  if (target == null) return false;
  try {
    rmSync(target, { force: true });
    return true;
  } catch {
    logEvent({
      level: "warn",
      source: "download",
      event: "download.manifest.write_failed",
      message: `取消标记清除失败: ${repoId} / ${variant}`,
      detail: { repoId, variant },
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// 纯逻辑
// ---------------------------------------------------------------------------

/**
 * 拿 manifest 和「磁盘上实际有哪些文件、各多大」比对。
 *
 * 规则：
 *   - manifest 里有、磁盘上没有 → `missing`
 *   - 磁盘大小 < 声称大小 → `short`（磁盘更大不算问题，来源可能报压缩前大小）
 *   - `size` 为 null（来源没说大小）→ 只要文件在就算数
 */
export function checkAgainstDisk(
  manifest: DownloadManifest,
  onDisk: ReadonlyMap<string, number>,
): ManifestCheck {
  const missing: string[] = [];
  const short: Array<{ path: string; expected: number; actual: number }> = [];
  for (const file of manifest.files) {
    const actual = onDisk.get(file.path);
    if (actual === undefined) {
      missing.push(file.path);
      continue;
    }
    if (file.size !== null && actual < file.size) {
      short.push({ path: file.path, expected: file.size, actual });
    }
  }
  return { complete: missing.length === 0 && short.length === 0, missing, short };
}
