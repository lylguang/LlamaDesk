import { describe, expect, test } from "bun:test";

import {
  formatEta,
  groupDownloadsByRepo,
  modelGroupStatus,
  queuePositionOf,
  summarizeDownloads,
  summarizeModelDownload,
  taskEta,
} from "./download-view";
import type { DownloadTask } from "../../bun/download-manager";
import { translate } from "../../shared/i18n";

const t = (key: string, params?: Record<string, string>) => translate("zh", key, params);

function task(patch: Partial<DownloadTask>): DownloadTask {
  return {
    id: patch.id ?? "id",
    repo: "some/repo",
    fileName: patch.fileName ?? "model.safetensors",
    source: "modelscope",
    status: "queued",
    received: 0,
    total: null,
    percent: null,
    speed: 0,
    createdAt: 0,
    size: null,
    order: 0,
    ...patch,
  };
}

describe("剩余时间", () => {
  test("按速度与剩余字节给出秒/分/小时", () => {
    expect(formatEta(0, 1000, t)).toBeNull();
    expect(formatEta(1000, 0, t)).toBeNull();
    expect(formatEta(5_000, 1_000, t)).toBe("约 5 秒");
    expect(formatEta(300_000, 1_000, t)).toBe("约 5 分钟"); // 300s = 5min
    expect(formatEta(3 * 3600 * 1_000_000, 1_000_000, t)).toBe("约 3 小时 0 分钟"); // 3h
  });

  test("只有正在下载且总量已知才给任务级剩余时间", () => {
    const downloading = task({ status: "downloading", received: 1_000, total: 11_000, speed: 1_000 });
    expect(taskEta(downloading, t)).toBe("约 10 秒");
    // 排队中还没有速度，不显示剩余时间（显示的是「前面还有几个」）。
    expect(taskEta(task({ status: "queued", total: 100, speed: 500 }), t)).toBeNull();
    // 总量未知。
    expect(taskEta(task({ status: "downloading", received: 10, total: null, speed: 5 }), t)).toBeNull();
    // size 也能当总量用（市场列表给的，还没探测）。
    expect(taskEta(task({ status: "downloading", received: 0, size: 4_000, speed: 1_000 }), t)).toBe(
      "约 4 秒",
    );
  });
});

describe("排队位置", () => {
  test("小文件优先：体积小的排在前面，位置从 1 数起", () => {
    const big = task({ id: "big", size: 4_000_000_000, createdAt: 1 });
    const small = task({ id: "small", size: 1_000, createdAt: 2 });
    const mid = task({ id: "mid", size: 20_000, createdAt: 3 });
    const all = [big, small, mid];

    expect(queuePositionOf(small, all)).toBe(1);
    expect(queuePositionOf(mid, all)).toBe(2);
    expect(queuePositionOf(big, all)).toBe(3);
  });

  test("显式点击的任务排在最前，未知体积排在同类末尾", () => {
    const explicit = task({ id: "explicit", size: 9_000_000_000, createdAt: 9, order: -1 });
    const small = task({ id: "small", size: 100, createdAt: 1 });
    const unknown = task({ id: "unknown", size: null, createdAt: 2 });
    const all = [small, unknown, explicit];

    expect(queuePositionOf(explicit, all)).toBe(1);
    expect(queuePositionOf(small, all)).toBe(2);
    expect(queuePositionOf(unknown, all)).toBe(3);
  });

  test("正在下载/已暂停/已完成不算排队", () => {
    const running = task({ id: "run", status: "downloading" });
    const paused = task({ id: "pause", status: "paused" });
    expect(queuePositionOf(running, [running, paused])).toBeNull();
    expect(queuePositionOf(paused, [running, paused])).toBeNull();
  });
});

describe("聚合进度", () => {
  test("合计已下/总量、速度与剩余字节（总量未知的任务不计入比例）", () => {
    const tasks = [
      task({ id: "a", status: "downloading", received: 100, total: 400, speed: 100 }),
      task({ id: "b", status: "queued", received: 0, total: 100, speed: 0 }),
      // 总量未知：计入已下与活跃数，但不计入比例。
      task({ id: "c", status: "downloading", received: 50, total: null, speed: 50, size: null }),
      // 已完成的不算活跃。
      task({ id: "d", status: "completed", received: 999, total: 999, speed: 0 }),
    ];
    const summary = summarizeDownloads(tasks);
    expect(summary.activeCount).toBe(3);
    expect(summary.received).toBe(150);
    expect(summary.total).toBe(500);
    expect(summary.remainingBytes).toBe(400); // (400-100) + (100-0)
    expect(summary.speed).toBe(150);
    expect(summary.percent).toBe(30);
  });

  test("没有任何已知总量时不给百分比", () => {
    const summary = summarizeDownloads([
      task({ id: "a", status: "downloading", received: 10, total: null, size: null, speed: 10 }),
    ]);
    expect(summary.percent).toBeNull();
    expect(summary.activeCount).toBe(1);
    expect(summary.received).toBe(10);
  });

  test("空闲时全为零", () => {
    const summary = summarizeDownloads([task({ id: "d", status: "completed" })]);
    expect(summary).toEqual({
      speed: 0,
      received: 0,
      total: 0,
      remainingBytes: 0,
      percent: null,
      activeCount: 0,
    });
  });
});

describe("整模型进度", () => {
  test("已完成的文件也计入分子分母（不是只算还在下的那几个）", () => {
    const tasks = [
      task({ id: "a", status: "completed", received: 300, total: 300 }),
      task({ id: "b", status: "completed", received: 300, total: 300 }),
      task({ id: "c", status: "downloading", received: 100, total: 400, speed: 50 }),
    ];
    const model = summarizeModelDownload(tasks);
    // 300 + 300 + 100 = 700 / 1000 —— 而不是只算 c 的 100/400。
    expect(model.received).toBe(700);
    expect(model.total).toBe(1000);
    expect(model.percent).toBe(70);
    // 速度只算正在下的那个文件。
    expect(model.speed).toBe(50);
    expect(model.activeCount).toBe(1);
    // 对照：只统计活跃任务的 summarizeDownloads 看不到已完成的文件。
    expect(summarizeDownloads(tasks).percent).toBe(25);
  });

  test("完成的文件按整份计入，缺 total 的用市场清单的 size 兜底", () => {
    const tasks = [
      // 完成的文件 received 可能偏小（续传没探测到完整总量）→ 按 size 整份算。
      task({ id: "a", status: "completed", received: 10, total: null, size: 500 }),
      task({ id: "b", status: "downloading", received: 0, total: null, size: 500 }),
    ];
    const model = summarizeModelDownload(tasks);
    expect(model.total).toBe(1000);
    expect(model.received).toBe(500);
    expect(model.percent).toBe(50);
  });

  test("一个总量都不知道时不给百分比", () => {
    const model = summarizeModelDownload([
      task({ id: "a", status: "downloading", received: 10, total: null, size: null }),
    ]);
    expect(model.percent).toBeNull();
    expect(model.received).toBe(10);
  });
});

describe("模型状态", () => {
  test("正在下压过失败：还有文件在跑时不该显示成一个「重试」", () => {
    expect(
      modelGroupStatus([
        task({ id: "a", status: "failed" }),
        task({ id: "b", status: "downloading" }),
      ]),
    ).toBe("downloading");
  });

  test("优先级：正在下 > 等待 > 失败 > 暂停 > 全部完成", () => {
    expect(modelGroupStatus([task({ id: "a", status: "queued" }), task({ id: "b", status: "failed" })])).toBe("queued");
    expect(modelGroupStatus([task({ id: "a", status: "failed" }), task({ id: "b", status: "paused" })])).toBe("failed");
    expect(modelGroupStatus([task({ id: "a", status: "paused" }), task({ id: "b", status: "completed" })])).toBe("paused");
    expect(modelGroupStatus([task({ id: "a", status: "completed" }), task({ id: "b", status: "completed" })])).toBe("completed");
  });
});

describe("按模型分组", () => {
  test("同一仓库的多个文件合成一组，计数与整模型进度都对得上", () => {
    const groups = groupDownloadsByRepo([
      task({ id: "a", fileName: "config.json", status: "completed", received: 100, total: 100 }),
      task({ id: "b", fileName: "model.safetensors", status: "failed", received: 0, total: 900 }),
    ]);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(g.repo).toBe("some/repo");
    expect(g.key).toBe("some/repo");
    expect(g.fileCount).toBe(2);
    expect(g.doneCount).toBe(1);
    expect(g.failedCount).toBe(1);
    expect(g.status).toBe("failed");
    expect(g.summary.percent).toBe(10); // 100 / 1000
  });

  test("GGUF 每个量化是独立模型，不能合并成一组", () => {
    const groups = groupDownloadsByRepo([
      task({ id: "a", fileName: "Qwen3-4B-Q4_K_M.gguf" }),
      task({ id: "b", fileName: "Qwen3-4B-Q8_0.gguf" }),
      task({ id: "c", fileName: "config.json" }),
    ]);
    // 两个 gguf 各占一组 + 其余文件归仓库那一组 = 3 组。
    expect(groups).toHaveLength(3);
    const gguf = groups.filter((g) => g.fileName);
    expect(gguf).toHaveLength(2);
    expect(gguf.map((g) => g.label).sort()).toEqual(["Qwen3-4B-Q4_K_M.gguf", "Qwen3-4B-Q8_0.gguf"]);
    // 非 gguf 的那组还是按仓库聚合。
    expect(groups.find((g) => !g.fileName)?.fileCount).toBe(1);
  });

  test("活跃的模型排在历史前面，历史按最近活动倒序", () => {
    const groups = groupDownloadsByRepo([
      task({ id: "old", repo: "a/old", status: "completed", fileName: "x.safetensors", createdAt: 1 }),
      task({ id: "new", repo: "b/new", status: "completed", fileName: "y.safetensors", createdAt: 9 }),
      task({ id: "run", repo: "c/run", status: "downloading", fileName: "z.safetensors", createdAt: 5 }),
    ]);
    expect(groups.map((g) => g.repo)).toEqual(["c/run", "b/new", "a/old"]);
  });

  test("同一个文件的陈旧失败任务不会让整模型一直显示「失败」", () => {
    // 真实现场：09:57 那次失败留下一条 failed，随后重下成功又建了一条 completed，
    // 两条都还在列表里（start() 只在旧任务未结束时复用）。
    const groups = groupDownloadsByRepo([
      task({ id: "stale", fileName: "config.json", status: "failed", received: 9258, total: 9258, size: 9258, createdAt: 1 }),
      task({ id: "fresh", fileName: "config.json", status: "completed", received: 9258, total: 9258, size: 9258, createdAt: 9 }),
      task({ id: "other", fileName: "tokenizer.json", status: "completed", received: 10, total: 10, size: 10, createdAt: 5 }),
    ]);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    // 每个文件只算一次：2 个文件，不是 3 条任务。
    expect(g.fileCount).toBe(2);
    expect(g.failedCount).toBe(0);
    expect(g.doneCount).toBe(2);
    expect(g.status).toBe("completed");
    expect(g.summary.percent).toBe(100);
  });

  test("去重保留进展最靠前的那条（顺序无关）", () => {
    const stale = task({ id: "stale", fileName: "a.safetensors", status: "failed", createdAt: 9 });
    const fresh = task({ id: "fresh", fileName: "a.safetensors", status: "downloading", createdAt: 1 });
    expect(groupDownloadsByRepo([stale, fresh])[0]!.status).toBe("downloading");
    expect(groupDownloadsByRepo([fresh, stale])[0]!.status).toBe("downloading");
  });
});
