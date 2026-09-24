import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { clearAppLog as clearLogs, readAppLogs as readLogs } from "./app-log";
import { tmpdir } from "os";
import { join } from "path";

import { mockModulePartial } from "./test-mocks";
import { writeDownloadManifest } from "./download-manifest";

/**
 * 下载队列的排序行为：小文件先下、显式点击插队、失败自动重试后才判死、
 * 老版本持久化的任务恢复后仍按体积重排。
 *
 * 只桩掉数据库设置与**下载调用**（不联网、不碰用户数据目录），队列与状态机用的是
 * 下载管理器自己的实现；「磁盘上有没有部分数据」用**真临时目录**里的真文件表达。
 *
 * 这里**不能**去 `mock.module("fs", …)`：bun 的 mock 注册表在同一批次里跨文件共享，
 * 把整个 fs 替换掉会污染同批次里所有做真实 IO 的测试 —— 实测 `downloader.test.ts`
 * 因而偶发失败（6 次里 1 次「下载中断（2820/20971520 字节）」），而且它返回的假
 * readdir 结果会让别的套件的用例计数飘。真文件 + 真目录没有这个问题。
 */

const settings = new Map<string, string>();
await mockModulePartial<typeof import("./db/settings")>("./db/settings", {
  getSetting: (key) => settings.get(key) ?? "",
  updateSettings: (patch) => {
    for (const [k, v] of Object.entries(patch)) settings.set(k, v);
  },
});

await mockModulePartial<typeof import("./model-store")>("./model-store", {
  setModelMeta: () => {},
});

/**
 * 这个文件的「磁盘」：一个真临时目录，`reset()` 会把 `seedFiles` 落成真文件
 * （下载管理器只看「存在且 size > 0」与同目录的 `.part*`）。
 */
// `reset()` 会整体重建这个目录（模拟一次全新的磁盘），所以 helper 统一通过这个
// getter 取路径，不能引用模块加载时的常量值（reset 之后那已经不存在了）。
let modelsRoot = mkdtempSync(join(tmpdir(), "omni-download-manager-test-"));
const modelsRootOf = () => modelsRoot;

/** 前 N 次下载调用抛错（模拟 ModelScope 偶发 500）。 */
let failFirst = 0;
/** 已启动的下载（按启动顺序），每个都闸住直到测试放行。 */
const started: string[] = [];
let gates: Array<() => void> = [];

await mockModulePartial<typeof import("./modelscope")>("./modelscope", {
  modelDestPath: (repo, fileName) => join(modelsRootOf(), repo.replace("/", "__"), fileName),
  // 与下载落盘共用同一个模型根（真实 getModelsBaseDir 读 OMNI_DATA_DIR，与
  // test-preload 的临时数据目录一致）—— verify 时扫的就是这里。
  getModelsBaseDir: () => modelsRootOf(),
  removePartialFiles: () => {},
  downloadFile: async (_repo: string, fileName: string) => {
    if (failFirst > 0) {
      failFirst -= 1;
      throw new Error("Download failed: 500");
    }
    const gate = new Promise<void>((resolve) => gates.push(resolve));
    started.push(fileName);
    await gate;
    return { path: `models/${fileName}`, size: 1 };
  },
  downloadHuggingFaceFile: async (_repo: string, fileName: string) => {
    const gate = new Promise<void>((resolve) => gates.push(resolve));
    started.push(fileName);
    await gate;
    return { path: `models/${fileName}`, size: 1 };
  },
});

const { DownloadManager } = await import("./download-manager");

beforeAll(() => {
  // 清掉本进程内存里的旧日志（同进程内其它测试文件可能写过），只留本文件的断言对象。
  clearLogs();
});

afterAll(() => {
  for (const release of gates) release();
  clearLogs();
  rmSync(modelsRoot, { recursive: true, force: true });
});

/** 换一批「磁盘上已有数据」的文件：`seedFiles` 落成真文件，其余清空。 */
function reset(seedFiles: string[] = [], failures = 0) {
  rmSync(modelsRoot, { recursive: true, force: true });
  modelsRoot = mkdtempSync(join(tmpdir(), "omni-download-manager-test-"));
  const repoDir = join(modelsRoot, "some__repo");
  mkdirSync(repoDir, { recursive: true });
  for (const name of seedFiles) writeFileSync(join(repoDir, name), Buffer.alloc(1024));
  failFirst = failures;
  started.length = 0;
  gates = [];
}

async function waitFor(
  dm: InstanceType<typeof DownloadManager>,
  id: string,
  predicate: (task: import("./download-manager").DownloadTask) => boolean,
  timeoutMs = 2_000,
) {
  const deadline = Date.now() + timeoutMs;
  let last = dm.list().find((t) => t.id === id);
  while (Date.now() < deadline) {
    last = dm.list().find((t) => t.id === id);
    if (last && predicate(last)) return { ...last };
    await Bun.sleep(10);
  }
  return last;
}

/** 轮询一个布尔条件直到为真（或超时，返回最后的值）。 */
async function waitForBool(fn: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let last = fn();
  while (!last && Date.now() < deadline) {
    await Bun.sleep(10);
    last = fn();
  }
  return last;
}

/** 等到至少 n 个下载被启动。 */
async function waitForCount(list: string[], n: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (list.length < n && Date.now() < deadline) await Bun.sleep(10);
}

/** 放掉被闸住的下载，等调度器把下一批跑起来。 */
async function releaseAll() {
  const pending = gates;
  gates = [];
  for (const release of pending) release();
  await Bun.sleep(30);
}

test("批量入队按体积升序出队：小文件先下，大权重排最后", async () => {
  reset();
  const dm = new DownloadManager();
  const repo = "some/repo";
  // 故意按「大 → 小」入队（市场列表就是权重优先、体积降序）。
  dm.start(repo, "model-00002-of-00002.safetensors", "chat", "modelscope", { size: 4_000_000_000 });
  dm.start(repo, "model-00001-of-00002.safetensors", "chat", "modelscope", { size: 3_000_000_000 });
  dm.start(repo, "tokenizer.json", "chat", "modelscope", { size: 1_800_000 });
  dm.start(repo, "config.json", "chat", "modelscope", { size: 900 });
  dm.start(repo, "model.safetensors.index.json", "chat", "modelscope", { size: 24_000 });

  await Bun.sleep(30);
  // 并发上限 2：先跑的必须是最小的两个。
  expect(started).toEqual(["config.json", "model.safetensors.index.json"]);

  await releaseAll();
  await waitForCount(started, 3);
  expect(started.slice(0, 3).sort()).toEqual([
    "config.json",
    "model.safetensors.index.json",
    "tokenizer.json",
  ]);

  await releaseAll();
  await releaseAll();
  await waitForCount(started, 5);
  expect(started.slice(3).sort()).toEqual([
    "model-00001-of-00002.safetensors",
    "model-00002-of-00002.safetensors",
  ]);

  await releaseAll();
});

test("显式点击的任务插队，优先于批量小文件", async () => {
  reset();
  const dm = new DownloadManager();
  const repo = "some/repo";
  // 批量：最小的先跑，大文件一个跑一个排队。
  dm.start(repo, "big-a.safetensors", "chat", "modelscope", { size: 8_000_000_000 });
  dm.start(repo, "big-b.safetensors", "chat", "modelscope", { size: 7_000_000_000 });
  dm.start(repo, "small.json", "chat", "modelscope", { size: 100 });
  await waitForCount(started, 2);
  expect(started.slice().sort()).toEqual(["big-b.safetensors", "small.json"]);
  expect(dm.list().find((t) => t.fileName === "big-a.safetensors")?.status).toBe("queued");

  // 用户单独点了这个文件 → 它要排在 small.json 前面（哪怕体积大得多）。
  dm.start(repo, "user-pick.gguf", "chat", "modelscope", {
    size: 9_000_000_000,
    explicit: true,
  });

  await releaseAll();
  // 释放一个并发位后，下一个启动的必须是用户点的那个。
  expect(started[2]).toBe("user-pick.gguf");
  await releaseAll();
  await releaseAll();
});

test("下载失败会自动重试，重试成功则不标记失败", async () => {
  reset([], 1); // 第一次调用失败
  const dm = new DownloadManager();
  const task = dm.start("some/repo", "retry.bin", "chat", "modelscope", { size: 512 });

  // 第一次失败后排入重试（带次数与提示），不是直接 failed。
  const afterFail = await waitFor(dm, task.id, (t) => (t.retries ?? 0) >= 1);
  // 已经排入重试（可能已经重新在下了），关键是没被判死、并保留了重试次数与提示。
  expect(afterFail?.status).not.toBe("failed");
  expect(afterFail?.retries).toBe(1);
  expect(afterFail?.error).toContain("自动重试");

  // 退避 3s 后自动重来一次；这次服务端正常，放行后应圆满完成。
  await waitForCount(started, 1, 6_000);
  await releaseAll();
  const done = await waitFor(dm, task.id, (t) => t.status === "completed", 3_000);
  expect(done?.status).toBe("completed");
  expect(done?.retries).toBe(0);
  expect(done?.error).toBeUndefined();
}, 15_000);

test("老版本持久化的任务（没有 order/size）恢复后按体积续传", async () => {
  settings.set(
    "MODEL_DOWNLOADS",
    JSON.stringify([
      {
        id: "old-big",
        repo: "some/repo",
        fileName: "old-big.safetensors",
        source: "modelscope",
        status: "paused",
        received: 10,
        total: 9_000,
        percent: 1,
        speed: 0,
        createdAt: 1,
      },
      {
        id: "old-small",
        repo: "some/repo",
        fileName: "old-small.json",
        source: "modelscope",
        status: "paused",
        received: 1,
        total: 12,
        percent: 5,
        speed: 0,
        createdAt: 2,
      },
    ]),
  );
  // 这两个文件磁盘上都还有部分数据 → 恢复成 queued 续传。
  reset(["old-big.safetensors", "old-small.json"]);
  const dm = new DownloadManager();

  const big = dm.list().find((t) => t.id === "old-big");
  const small = dm.list().find((t) => t.id === "old-small");
  // 恢复出来的任务会立刻开始跑（下载被闸住 → 停在 downloading），两者都能续传。
  expect(big?.status === "queued" || big?.status === "downloading").toBe(true);
  expect(small?.status === "queued" || small?.status === "downloading").toBe(true);
  // 老任务缺 size：用已探测的 total 兜底，保证排序仍然正确。
  expect(big?.size).toBe(9_000);
  expect(small?.size).toBe(12);
  expect(typeof big?.order).toBe("number");

  await Bun.sleep(30);
  expect(started).toEqual(["old-small.json", "old-big.safetensors"]);
  await releaseAll();
});

test("重试用尽后标记失败，错误信息保留最终原因", async () => {
  reset([], 99); // 永远失败
  const dm = new DownloadManager();
  const task = dm.start("some/repo", "always-fails.bin", "chat", "modelscope", { size: 256 });

  // 第一次失败 → 排队重试；第二次（退避 3s 后）再失败 → 判死。
  await Bun.sleep(4_000);
  const done = dm.list().find((t) => t.id === task.id);
  expect(done?.status).toBe("failed");
  expect(done?.error).toContain("500");
  await releaseAll();
}, 15_000);

// ---------------------------------------------------------------------------
// manifest 接入（B2b）：下载开始前写清单、完成时比对磁盘、取消时打标记。
// manifest 与取消标记都在 OMNI_DATA_DIR（test-preload.ts 的临时目录）的
// downloads/ 下，直接读文件断言；日志断言用 app-log 的内存缓冲。
// ---------------------------------------------------------------------------

type MarketFile = { name: string; path: string; size: number };

/** 把「市场清单」写进真实模型目录（<数据目录>/models/<safeRepo>/）。 */
function seedRepoFiles(repo: string, files: MarketFile[]) {
  const repoDir = join(modelsRootOf(), repo.replace("/", "__"));
  for (const f of files) {
    const full = join(repoDir, f.path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, Buffer.alloc(f.size));
  }
}

const dataDownloads = () => join(process.env.OMNI_DATA_DIR!, "downloads");
let dataDownloadsOverride: string | null = null;

// manifest/取消标记的文件名规则与 download-manifest.ts 一致：
// `<safeRepoId(repo)>__<safeRepoId(variant) 或 _>.json`，variant 为空用 `_` 占位。
function recordName(repo: string, variant = ""): string {
  const safe = (s: string) => s.replace(/[/\\:\s]+/g, "__");
  return `${safe(repo)}__${variant === "" ? "_" : safe(variant)}.json`;
}
function downloadsRoot(): string {
  return dataDownloadsOverride ?? dataDownloads();
}
function manifestExists(repo: string): boolean {
  return existsSync(join(downloadsRoot(), "manifests", recordName(repo)));
}
function cancelledExists(repo: string): boolean {
  return existsSync(join(downloadsRoot(), "cancelled", recordName(repo)));
}
function manifestPathFor(repo: string): string {
  return join(downloadsRoot(), "manifests", recordName(repo));
}

test("正常下载跑完：开始前 manifest 被写过，完成时比对通过，清单不留残", async () => {
  const repo = "manifest/ok";
  const files: MarketFile[] = [
    { name: "config.json", path: "config.json", size: 100 },
    { name: "w.bin", path: "w.bin", size: 512 },
  ];
  reset();
  seedRepoFiles(repo, files);
  clearLogs();
  const dm = new DownloadManager();
  // 整仓库下载：市场清单随任务带进来（这里就是「下载整个模型」的路径）。
  const t1 = dm.start(repo, "config.json", "chat", "modelscope", {
    size: 100,
    manifestFiles: files,
  });
  dm.start(repo, "w.bin", "chat", "modelscope", { size: 512, manifestFiles: files });
  // 开始取文件前 manifest 就已落盘（两个任务写同一份）。
  const written = await waitForBool(() => manifestExists(repo), 2_000);
  expect(written).toBe(true);
  await releaseAll();
  await releaseAll();
  const done = await waitFor(dm, t1.id, (t) => t.status === "completed", 2_000);
  expect(done?.status).toBe("completed");
  // 完成时比对了 manifest（文件都在、大小一致 → verified）。
  const logs = readLogs({ event: "download.manifest.verified" });
  expect(logs.some((e) => (e.detail as { repo?: string } | undefined)?.repo === repo)).toBe(true);
  // 比对通过后 manifest 完成使命被删，不留陈旧清单。
  expect(manifestExists(repo)).toBe(false);
  expect(cancelledExists(repo)).toBe(false);
});

test("磁盘上少一个文件：记 download.manifest.incomplete，但任务仍是 completed，manifest 保留", async () => {
  const repo = "manifest/short";
  // 清单里有 3 个文件，但磁盘只下了前 2 个（第三个「下完」的文件根本没落盘，
  // 比如下载过程中被外部删掉 / 写入失败）。
  const files: MarketFile[] = [
    { name: "config.json", path: "config.json", size: 100 },
    { name: "a.bin", path: "a.bin", size: 200 },
    { name: "b.bin", path: "b.bin", size: 300 },
  ];
  reset();
  seedRepoFiles(repo, files.slice(0, 2));
  const dm = new DownloadManager();
  const t1 = dm.start(repo, "config.json", "chat", "modelscope", {
    size: 100,
    manifestFiles: files,
  });
  const t2 = dm.start(repo, "a.bin", "chat", "modelscope", { size: 200, manifestFiles: files });
  const t3 = dm.start(repo, "b.bin", "chat", "modelscope", { size: 300, manifestFiles: files });
  clearLogs(); // 开跑前的 manifest 写入警告等噪音不进去断言窗口
  await releaseAll();
  await releaseAll();
  await releaseAll();
  for (const id of [t1.id, t2.id, t3.id]) {
    const done = await waitFor(dm, id, (t) => t.status === "completed", 2_000);
    // incomplete 只记日志、不判失败（这一版先让数据跑起来，见 verifyManifest 注释）。
    expect(done?.status).toBe("completed");
  }
  const logs = readLogs({ event: "download.manifest.incomplete" });
  const hit = logs.find((e) => (e.detail as { repo?: string } | undefined)?.repo === repo);
  expect(hit).toBeDefined();
  expect(hit!.level).toBe("warn");
  const detail = hit!.detail as { missing?: string[] };
  expect(detail.missing).toEqual(["b.bin"]);
  // 保留 manifest：下次续传 / 扫描还要用它。
  expect(manifestExists(repo)).toBe(true);
});

test("取消 → 取消标记落盘；重新开始同一下载 → 标记被清掉", async () => {
  const repo = "manifest/cancel";
  reset();
  const dm = new DownloadManager();
  const task = dm.start(repo, "c.bin", "chat", "modelscope", { size: 40 });
  // 闸住不跑，直接取消。
  expect(dm.cancel(task.id)).toBe(true);
  expect(cancelledExists(repo)).toBe(true);

  // 重新下载同一仓库 → 开跑前取消标记被清掉。
  const t2 = dm.start(repo, "c.bin", "chat", "modelscope", { size: 40 });
  const cleared = await waitForBool(() => !cancelledExists(repo), 2_000);
  expect(cleared).toBe(true);
  await releaseAll();
  const done = await waitFor(dm, t2.id, (t) => t.status === "completed", 2_000);
  expect(done?.status).toBe("completed");
  expect(cancelledExists(repo)).toBe(false);
});

test("writeDownloadManifest 返回 false（写失败）→ 下载照常进行、照常成功", async () => {
  // 让 manifest 写入必然失败：把数据目录指到一个「downloads 本身是个文件」的
  // 位置（atomicWriteJson 建 manifests 子目录会抛 EEXIST → writeDownloadManifest
  // 返回 false 并自己记一条 warn）。不能用 mock.module 覆盖：bun 的 mock 是进程
  // 级、撤不掉，会弄脏同批次其它文件。env 在测试结束时恢复。
  const repo = "manifest/nowrite";
  reset();
  const realDataDir = process.env.OMNI_DATA_DIR!;
  const badData = join(modelsRootOf(), "no-write");
  mkdirSync(badData, { recursive: true });
  writeFileSync(join(badData, "downloads"), "");
  dataDownloadsOverride = join(badData, "downloads");
  process.env.OMNI_DATA_DIR = badData;
  // 前提确认：这个位置上的写入确实失败。
  expect(
    writeDownloadManifest({ repoId: repo, variant: "", files: [{ path: "n.bin", size: 32 }] }),
  ).toBe(false);
  const dm = new DownloadManager();
  const task = dm.start(repo, "n.bin", "chat", "modelscope", { size: 32 });
  // 下载被闸住直到放行；放行前先等它真的进闸。
  await waitForCount(started, 1, 2_000);
  await releaseAll();
  const done = await waitFor(dm, task.id, (t) => t.status === "completed", 2_000);
  expect(done?.status).toBe("completed");
  expect(done?.error).toBeUndefined();
  process.env.OMNI_DATA_DIR = realDataDir;
  dataDownloadsOverride = null;
  rmSync(badData, { recursive: true, force: true });
});
