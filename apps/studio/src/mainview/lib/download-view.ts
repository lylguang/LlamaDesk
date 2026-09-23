import type { DownloadTask } from "../../bun/download-manager";
import { formatBytes as formatBytesSi } from "@lib/format";

/**
 * 下载面板与市场文件行的展示计算：排队位置、剩余时间、聚合速度/剩余量。
 *
 * 都放在渲染期按当前 tasks 现算 —— 任务列表本来就会通过 downloadsChanged
 * 推送刷新，不必为「排队第几位」再引一条状态。
 */

/** 字节数的展示形式（GB / MB / KB）。下载面板沿用「0 B」占位与 1 位 MB 小数。 */
export function formatBytes(bytes: number): string {
  return formatBytesSi(bytes, { zero: "0 B", mbDecimals: 1 });
}

const ACTIVE: ReadonlySet<DownloadTask["status"]> = new Set([
  "downloading",
  "queued",
  "paused",
  "failed",
]);

export function isActiveStatus(status: DownloadTask["status"]): boolean {
  return ACTIVE.has(status);
}

export function isActiveTask(task: DownloadTask): boolean {
  return isActiveStatus(task.status);
}

/** 剩余时间的人类可读形式（如「约 3 分钟」）。速度或总量未知时返回 null。 */
export function formatEta(
  remainingBytes: number,
  speed: number,
  t: (key: string, params?: Record<string, string>) => string,
): string | null {
  if (!(remainingBytes > 0) || !(speed > 0)) return null;
  const seconds = Math.round(remainingBytes / speed);
  // 用 if 而不是三元链：三元在混排不同参数时很容易读错优先级
  // （这里踩过一次 —— 「3 小时」被渲染成「3 分钟」）。
  if (seconds < 60) {
    return t("downloads.etaSeconds", { n: String(Math.max(1, seconds)) });
  }
  if (seconds < 3600) {
    return t("downloads.etaMinutes", { n: String(Math.round(seconds / 60)) });
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return t("downloads.etaHours", { n: String(hours), m: String(minutes) });
}

/** 单个任务的剩余时间（速度与总量都已知时）。 */
export function taskEta(
  task: DownloadTask,
  t: (key: string, params?: Record<string, string>) => string,
): string | null {
  if (task.status !== "downloading") return null;
  const total = task.total ?? task.size ?? null;
  if (total == null) return null;
  return formatEta(Math.max(0, total - task.received), task.speed, t);
}

/**
 * 该任务在队列里的位置（1 起）。只对「等待中」有意义：
 * 正在下载/已暂停/已结束都返回 null。
 */
export function queuePositionOf(task: DownloadTask, tasks: readonly DownloadTask[]): number | null {
  if (task.status !== "queued") return null;
  const waiting = tasks
    .filter((t) => t.status === "queued")
    // 与后端出队顺序保持一致：插队的（order < 0）在前，其余按体积升序。
    .sort((a, b) => {
      const ra = a.order < 0 ? [0, -a.createdAt] : [1, a.size ?? Number.MAX_SAFE_INTEGER];
      const rb = b.order < 0 ? [0, -b.createdAt] : [1, b.size ?? Number.MAX_SAFE_INTEGER];
      return ra[0]! - rb[0]! || ra[1]! - rb[1]! || a.createdAt - b.createdAt;
    });
  const index = waiting.findIndex((t) => t.id === task.id);
  return index >= 0 ? index + 1 : null;
}

export type DownloadSummary = {
  /** 正在传输的字节/秒合计。 */
  speed: number;
  /** 已下字节合计（活跃任务）。 */
  received: number;
  /** 需要下载的字节合计（只有已知总量计入）。 */
  total: number;
  /** 还差多少字节（总数未知的任务不计入）。 */
  remainingBytes: number;
  /** 已完成比例（0-100），至少一个任务的 total 已知才有值。 */
  percent: number | null;
  activeCount: number;
};

/** 聚合统计：面板头部显示「合计 1.2/4.5 GB · 12 MB/s · 约 3 分钟」。 */
export function summarizeDownloads(tasks: readonly DownloadTask[]): DownloadSummary {
  let speed = 0;
  let remainingBytes = 0;
  let received = 0;
  let total = 0;
  let activeCount = 0;
  let anyTotal = false;

  for (const task of tasks) {
    if (!isActiveTask(task)) continue;
    activeCount += 1;
    speed += task.speed;
    received += task.received;
    const taskTotal = task.total ?? task.size ?? null;
    if (taskTotal != null && taskTotal > 0) {
      anyTotal = true;
      total += taskTotal;
      remainingBytes += Math.max(0, taskTotal - task.received);
    }
  }

  return {
    speed,
    received,
    total,
    remainingBytes,
    percent: anyTotal && total > 0 ? Math.floor((received / total) * 100) : null,
    activeCount,
  };
}

/**
 * 单个文件的「总量」：优先用已确认的 total，退回市场清单给的 size。
 * 两者都没有（还没探测）则为 null —— 不能当成 0，否则模型级百分比会虚高。
 */
export function taskTotalBytes(task: DownloadTask): number | null {
  const total = task.total ?? task.size ?? null;
  return total != null && total > 0 ? total : null;
}

/**
 * 整模型进度：**已完成的文件也算进分子分母**。
 *
 * 这是与 `summarizeDownloads`（只统计活跃任务）的关键区别：面板头部回答的是
 * 「现在还在下多少」，而模型卡片回答的是「这个模型整体下了多少」—— 12 个文件
 * 下完 9 个时必须显示 75%，而不是「剩下 3 个文件的 0%」。
 */
export function summarizeModelDownload(tasks: readonly DownloadTask[]): DownloadSummary {
  let speed = 0;
  let received = 0;
  let total = 0;
  let activeCount = 0;
  let anyTotal = false;

  for (const task of tasks) {
    if (isActiveTask(task)) {
      activeCount += 1;
      speed += task.speed;
    }
    const fileTotal = taskTotalBytes(task);
    if (fileTotal != null) {
      anyTotal = true;
      total += fileTotal;
      // 完成的文件按整份计入（它的 received 可能因为续传探测不到完整总量而偏小）。
      received += task.status === "completed" ? fileTotal : Math.min(task.received, fileTotal);
    } else {
      received += task.received;
    }
  }

  return {
    speed,
    received,
    total,
    remainingBytes: Math.max(0, total - received),
    percent: anyTotal && total > 0 ? Math.floor((received / total) * 100) : null,
    activeCount,
  };
}

/**
 * 一组任务（同一个模型的所有文件）在界面上呈现成什么状态。
 *
 * 优先级：正在下 > 等待中 > 失败 > 已暂停 > 全部完成 > 已取消。
 * 「正在下」压过「失败」是有意的：12 个文件里 3 个失败、其余还在下时，
 * 用户该看到的是进度和「暂停」，而不是一个「重试」把还在跑的任务也搅进来。
 */
export function modelGroupStatus(tasks: readonly DownloadTask[]): DownloadTask["status"] {
  let hasDownloading = false;
  let hasQueued = false;
  let hasFailed = false;
  let hasPaused = false;
  let hasCanceled = false;
  let allDone = true;

  for (const task of tasks) {
    switch (task.status) {
      case "downloading":
        hasDownloading = true;
        allDone = false;
        break;
      case "queued":
        hasQueued = true;
        allDone = false;
        break;
      case "failed":
        hasFailed = true;
        allDone = false;
        break;
      case "paused":
        hasPaused = true;
        allDone = false;
        break;
      case "canceled":
        hasCanceled = true;
        allDone = false;
        break;
      case "completed":
        break;
    }
  }

  if (hasDownloading) return "downloading";
  if (hasQueued) return "queued";
  if (hasFailed) return "failed";
  if (hasPaused) return "paused";
  if (allDone) return "completed";
  return hasCanceled ? "canceled" : "completed";
}

export type ModelDownloadGroup = {
  /** 分组键：多文件模型是 repo，GGUF 单文件是 `repo::文件名`（每个量化是独立模型）。 */
  key: string;
  repo: string;
  /** 单文件组（GGUF 量化）才有：这一组就是这一个文件。 */
  fileName?: string;
  /** 界面上的名字：单文件组用文件名，其余用仓库名。 */
  label: string;
  /** 组内文件的下载源（正常情况下一致，取出现最多的那个）。 */
  source: DownloadTask["source"];
  tasks: DownloadTask[];
  fileCount: number;
  doneCount: number;
  failedCount: number;
  /** 组级状态：界面上那一个按钮/徽章按它显示。 */
  status: DownloadTask["status"];
  summary: DownloadSummary;
  /** 组内最近一次创建时间，用于排序（活跃的在前、历史按时间倒序）。 */
  updatedAt: number;
};

/** GGUF 单文件本身就是可独立运行的模型，不同量化之间不能合并成一行。 */
const SINGLE_FILE_RE = /\.gguf$/i;

/** 同一个文件可能有多条任务（失败后重下会新建一条），聚合时按「进展最靠前」留一条。 */
const STATUS_RANK: Record<DownloadTask["status"], number> = {
  completed: 0,
  downloading: 1,
  queued: 2,
  paused: 3,
  failed: 4,
  canceled: 5,
};

/**
 * 同一个仓库（或同一个 GGUF 文件）里，每个文件只留进度最靠前的那条任务。
 *
 * `start()` 在旧任务是 completed / canceled 时会新建一条，失败后重下同理 ——
 * 于是磁盘上会同时存在「09:57 失败的那条」和「刚才下好的那条」。不去重的话，
 * 整模型聚合会把这两条都算进去：文件数虚高，而且一条陈旧的 failed 会让整个
 * 模型永远顶着「失败」，尽管文件其实已经下好了。
 */
export function dedupeByFile(tasks: readonly DownloadTask[]): DownloadTask[] {
  const best = new Map<string, DownloadTask>();
  for (const task of tasks) {
    const cur = best.get(task.fileName);
    if (!cur || STATUS_RANK[task.status] < STATUS_RANK[cur.status]) {
      best.set(task.fileName, task);
    }
  }
  return [...best.values()];
}

/**
 * 把任务合并成界面上的「一个下载单元」。
 *
 * 用户视角里下载的单元是「一个模型」，不是一个文件：safetensors 仓库的 12 个
 * 分片 + config + tokenizer 本来就必须一起下完才能加载，逐个文件列进度既看不出
 * 模型整体下了多少，也让界面被十几个进度条淹掉。任务本身仍是文件级的
 * （断点续传、重试都在那一层），聚合只发生在展示层。
 *
 * 例外是 GGUF：一个仓库里 .gguf 是几十个不同量化，每个都是能独立跑的模型，
 * 合并成一行会把「下了 3B-Q4 和 7B-Q8 两个量化」显示成「同一模型下了 50%」。
 */
export function groupDownloadsByRepo(tasks: readonly DownloadTask[]): ModelDownloadGroup[] {
  const byKey = new Map<string, { repo: string; fileName?: string; tasks: DownloadTask[] }>();
  for (const task of tasks) {
    const single = SINGLE_FILE_RE.test(task.fileName);
    const key = single ? `${task.repo}::${task.fileName}` : task.repo;
    const hit = byKey.get(key);
    if (hit) hit.tasks.push(task);
    else byKey.set(key, { repo: task.repo, fileName: single ? task.fileName : undefined, tasks: [task] });
  }

  const groups: ModelDownloadGroup[] = [];
  for (const [key, entry] of byKey) {
    const list = dedupeByFile(entry.tasks);
    // 源以出现最多的为准：极端情况下同一模型混了来源，界面显示主流那一个。
    const sourceCount = new Map<DownloadTask["source"], number>();
    let doneCount = 0;
    let failedCount = 0;
    let updatedAt = 0;
    for (const task of list) {
      sourceCount.set(task.source, (sourceCount.get(task.source) ?? 0) + 1);
      if (task.status === "completed") doneCount += 1;
      if (task.status === "failed") failedCount += 1;
      updatedAt = Math.max(updatedAt, task.createdAt);
    }
    let source: DownloadTask["source"] = list[0]!.source;
    let best = 0;
    for (const [s, n] of sourceCount) {
      if (n > best) {
        best = n;
        source = s;
      }
    }

    groups.push({
      key,
      repo: entry.repo,
      fileName: entry.fileName,
      label: entry.fileName ?? entry.repo,
      source,
      tasks: list,
      fileCount: list.length,
      doneCount,
      failedCount,
      status: modelGroupStatus(list),
      summary: summarizeModelDownload(list),
      updatedAt,
    });
  }

  // 活跃的（正在下/等待/暂停/失败）排前面，历史（已完成/取消）按时间倒序跟在后面。
  const rank = (g: ModelDownloadGroup) => (isActiveStatus(g.status) ? 0 : 1);
  return groups.sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
}

/** 某个模型（repo）在当前任务列表里的那一组（多文件模型；GGUF 按文件分组时用 findGroupForFile）。 */
export function findGroupByRepo(
  groups: readonly ModelDownloadGroup[],
  repo: string,
): ModelDownloadGroup | null {
  return groups.find((g) => !g.fileName && g.repo === repo) ?? null;
}

/** 某个具体文件所属的组（GGUF 量化行）；非单文件模型回落到整仓库那一组。 */
export function findGroupForFile(
  groups: readonly ModelDownloadGroup[],
  repo: string,
  fileName: string,
): ModelDownloadGroup | null {
  return (
    groups.find((g) => g.repo === repo && g.fileName === fileName) ??
    findGroupByRepo(groups, repo)
  );
}
