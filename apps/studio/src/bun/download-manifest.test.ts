/**
 * download-manifest 单元测试。
 *
 * 数据目录由 test-preload.ts 统一指向临时目录（OMNI_DATA_DIR）；这里再覆盖
 * 一层（各自独立临时目录），保证本文件与其它测试互不串。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  DOWNLOAD_MANIFEST_SCHEMA,
  checkAgainstDisk,
  clearDownloadCancelled,
  isDownloadCancelled,
  markDownloadCancelled,
  readDownloadManifest,
  removeDownloadManifest,
  writeDownloadManifest,
  type DownloadManifest,
  type ExpectedFile,
} from "./download-manifest";

const tmp = mkdtempSync(join(tmpdir(), "omni-manifest-test-"));
process.env.OMNI_DATA_DIR = tmp;
const DATA_DIR = process.env.OMNI_DATA_DIR!;

const MANIFESTS_DIR = join(DATA_DIR, "downloads", "manifests");
const CANCELLED_DIR = join(DATA_DIR, "downloads", "cancelled");

/** 与 shared/modelscope 的 safeRepoId 同一规则（测试里自己写，避免耦合）。 */
function safe(s: string): string {
  return s.replace(/[/\\:\s]+/g, "__");
}
function manifestPath(repoId: string, variant: string): string {
  return join(MANIFESTS_DIR, `${safe(repoId)}__${variant === "" ? "_" : safe(variant)}.json`);
}
function cancelledPath(repoId: string, variant: string): string {
  return join(CANCELLED_DIR, `${safe(repoId)}__${variant === "" ? "_" : safe(variant)}.json`);
}

const FILES: ExpectedFile[] = [
  { path: "config.json", size: 2048 },
  { path: "weights/model-00001-of-00002.safetensors", size: 5_000_000_000 },
  { path: "weights/model-00002-of-00002.safetensors", size: 2_500_000_000 },
  { path: "tokenizer.json", size: null },
];

beforeAll(() => {
  mkdirSync(MANIFESTS_DIR, { recursive: true });
  mkdirSync(CANCELLED_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

test("写 → 读回，字段正确", () => {
  const ok = writeDownloadManifest({ repoId: "org/repo", variant: "Q6_K_M", files: FILES });
  expect(ok).toBe(true);
  const m = readDownloadManifest("org/repo", "Q6_K_M");
  expect(m).not.toBeNull();
  if (m == null) return;
  expect(m.schema).toBe(DOWNLOAD_MANIFEST_SCHEMA);
  expect(m.repoId).toBe("org/repo");
  expect(m.variant).toBe("Q6_K_M");
  expect(typeof m.createdAt).toBe("number");
  expect(m.files).toEqual(FILES);
});

test("variant 为空时读回也是空字符串", () => {
  const ok = writeDownloadManifest({ repoId: "acme/model", variant: "", files: FILES });
  expect(ok).toBe(true);
  const m = readDownloadManifest("acme/model", "");
  expect(m).not.toBeNull();
  expect(m?.variant).toBe("");
});

test("JSON 损坏 → readDownloadManifest 返回 null（不抛）", () => {
  const path = manifestPath("org/repo", "Q6_K_M");
  const raw = readFileSync(path, "utf8");
  writeFileSync(path, "{ not valid json ]");
  expect(() => readDownloadManifest("org/repo", "Q6_K_M")).not.toThrow();
  expect(readDownloadManifest("org/repo", "Q6_K_M")).toBeNull();
  writeFileSync(path, raw); // 恢复
  expect(readDownloadManifest("org/repo", "Q6_K_M")).not.toBeNull();
});

test("schema 不符 → null", () => {
  const path = manifestPath("org/repo", "Q6_K_M");
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as DownloadManifest;
  writeFileSync(path, JSON.stringify({ ...parsed, schema: 999 }));
  expect(readDownloadManifest("org/repo", "Q6_K_M")).toBeNull();
  writeFileSync(path, raw);
});

test("文件不存在 → null（fail-open）", () => {
  expect(readDownloadManifest("nobody/never", "x")).toBeNull();
});

test("checkAgainstDisk：全齐 → complete", () => {
  const m = readDownloadManifest("org/repo", "Q6_K_M")!;
  const onDisk = new Map(
    m.files.map((f) => [f.path, f.size ?? 1] as [string, number]),
  );
  const r = checkAgainstDisk(m, onDisk);
  expect(r.complete).toBe(true);
  expect(r.missing).toEqual([]);
  expect(r.short).toEqual([]);
});

test("checkAgainstDisk：缺一个 → missing 里有它", () => {
  const m = readDownloadManifest("org/repo", "Q6_K_M")!;
  const onDisk = new Map(m.files.map((f) => [f.path, f.size ?? 1] as [string, number]));
  onDisk.delete("weights/model-00002-of-00002.safetensors");
  const r = checkAgainstDisk(m, onDisk);
  expect(r.complete).toBe(false);
  expect(r.missing).toEqual(["weights/model-00002-of-00002.safetensors"]);
  expect(r.short).toEqual([]);
});

test("checkAgainstDisk：字节数不足 → short 且 expected/actual 正确", () => {
  const m = readDownloadManifest("org/repo", "Q6_K_M")!;
  const onDisk = new Map(m.files.map((f) => [f.path, f.size ?? 1] as [string, number]));
  onDisk.set("weights/model-00001-of-00002.safetensors", 1234);
  const r = checkAgainstDisk(m, onDisk);
  expect(r.complete).toBe(false);
  expect(r.missing).toEqual([]);
  expect(r.short).toEqual([
    { path: "weights/model-00001-of-00002.safetensors", expected: 5_000_000_000, actual: 1234 },
  ]);
});

test("checkAgainstDisk：size 为 null 的文件只要存在就不算问题", () => {
  const m = readDownloadManifest("org/repo", "Q6_K_M")!;
  const onDisk = new Map(m.files.map((f) => [f.path, f.size ?? 1] as [string, number]));
  onDisk.set("tokenizer.json", 0); // 存在但大小 0
  const r = checkAgainstDisk(m, onDisk);
  expect(r.short).toEqual([]);
  expect(r.missing).toEqual([]);
});

test("checkAgainstDisk：磁盘比声称的大 → 仍然 complete", () => {
  const m = readDownloadManifest("org/repo", "Q6_K_M")!;
  const onDisk = new Map(m.files.map((f) => [f.path, (f.size ?? 1) * 2] as [string, number]));
  const r = checkAgainstDisk(m, onDisk);
  expect(r.complete).toBe(true);
  expect(r.short).toEqual([]);
});

test("取消标记：打上 → true；清除后 → false", () => {
  expect(isDownloadCancelled("org/repo", "Q6_K_M")).toBe(false);
  expect(markDownloadCancelled("org/repo", "Q6_K_M", "用户取消")).toBe(true);
  expect(isDownloadCancelled("org/repo", "Q6_K_M")).toBe(true);
  expect(clearDownloadCancelled("org/repo", "Q6_K_M")).toBe(true);
  expect(isDownloadCancelled("org/repo", "Q6_K_M")).toBe(false);
  expect(clearDownloadCancelled("org/repo", "Q6_K_M")).toBe(true); // 幂等
});

test("取消标记内容损坏（非法 JSON）→ isDownloadCancelled 仍为 true（fail-closed）", () => {
  const path = cancelledPath("org/repo", "Q6_K_M");
  writeFileSync(path, "{{{{ definitely not json");
  expect(isDownloadCancelled("org/repo", "Q6_K_M")).toBe(true);
  expect(clearDownloadCancelled("org/repo", "Q6_K_M")).toBe(true);
  expect(isDownloadCancelled("org/repo", "Q6_K_M")).toBe(false);
});

test("repoId 带 ../ → 写入被拒绝，且没有文件被创建", () => {
  expect(writeDownloadManifest({ repoId: "../../evil", variant: "v", files: FILES })).toBe(false);
  expect(writeDownloadManifest({ repoId: "org/../../evil", variant: "v", files: FILES })).toBe(false);
  expect(writeDownloadManifest({ repoId: "org/repo", variant: "../evil", files: FILES })).toBe(false);
  expect(markDownloadCancelled("../../evil", "v")).toBe(false);
  // 数据目录之外（tmp 的父目录）不应出现 evil 文件
  const top = readdirSync(tmp, { recursive: false }) as string[];
  expect(top).not.toContain("evil");
  // 数据目录内部：被拒绝的写入不应留下任何 manifest/取消标记文件
  const inside = readdirSync(tmp, { recursive: true }) as string[];
  expect(inside.some((n) => n.includes("evil"))).toBe(false);
  const entries = readdirSync(MANIFESTS_DIR);
  expect(entries).not.toContain("../evil__v.json");
  expect(entries).not.toContain("..__..__evil__v.json");
  expect(entries).not.toContain("org__..__..__evil__v.json");
  const cancelledEntries = readdirSync(CANCELLED_DIR);
  expect(cancelledEntries).not.toContain("..__..__evil__v.json");
});

test("原子性：写完之后目录里没有残留临时文件", () => {
  writeDownloadManifest({ repoId: "org/atomic", variant: "full", files: FILES });
  markDownloadCancelled("org/atomic", "full");
  const leftovers: string[] = [];
  for (const dir of [MANIFESTS_DIR, CANCELLED_DIR]) {
    for (const entry of readdirSync(dir)) {
      if (entry.includes(".tmp") || entry.startsWith(".")) leftovers.push(`${dir}/${entry}`);
    }
  }
  expect(leftovers).toEqual([]);
});

test("removeDownloadManifest：存在 → true；不存在 → true（force）", () => {
  writeDownloadManifest({ repoId: "org/rm", variant: "", files: FILES });
  expect(existsSync(manifestPath("org/rm", ""))).toBe(true);
  expect(removeDownloadManifest("org/rm", "")).toBe(true);
  expect(readDownloadManifest("org/rm", "")).toBeNull();
  expect(removeDownloadManifest("org/rm", "")).toBe(true);
  expect(removeDownloadManifest("../../evil", "")).toBe(false);
});
