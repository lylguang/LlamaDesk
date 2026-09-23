import { describe, expect, test } from "bun:test";

import { readAppLogsInMemory } from "./app-log";
import { detectGpuStats, getGpuStats, type GpuCommandRunner } from "./gpu-stats";

/**
 * 探测路径按平台各走一遍，命令输出是注入的 —— CI 上没有 nvidia-smi、本地是 Apple 芯片，
 * 两边都要能跑到同一条断言（与 hardware.test.ts 同一套路）。
 */
type Answer = { code?: number; stdout?: string; stderr?: string };

const GPU_QUERY =
  "nvidia-smi --query-gpu=index,name,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw --format=csv,noheader,nounits";
const PROC_QUERY =
  "nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits";

function fakeRunner(answers: Record<string, Answer>): GpuCommandRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    run: async (cmd) => {
      const key = cmd.join(" ");
      calls.push(key);
      const answer = answers[key];
      return {
        code: answer?.code ?? 127,
        stdout: answer?.stdout ?? "",
        stderr: answer?.stderr ?? `command not found: ${cmd[0]}`,
      };
    },
  };
}

const MiB = 1024 * 1024;

describe("detectGpuStats", () => {
  test("Apple 芯片：不跑任何命令，reason 说明是统一内存", async () => {
    const runner = fakeRunner({});
    const stats = await detectGpuStats({ platform: "darwin", gpuKind: "apple", runner });

    expect(stats).toEqual({ available: false, reason: "unified-memory" });
    expect(runner.calls).toEqual([]);
  });

  test("Intel Mac 的独显：不跑命令，reason 说明 nvidia-smi 不适用", async () => {
    const runner = fakeRunner({});
    const stats = await detectGpuStats({ platform: "darwin", gpuKind: "amd", runner });

    expect(stats).toEqual({ available: false, reason: "non-nvidia" });
    expect(runner.calls).toEqual([]);
  });

  test("Linux + NVIDIA：整卡采样与逐进程显存都拿到", async () => {
    const runner = fakeRunner({
      [GPU_QUERY]: {
        code: 0,
        stdout: "0, NVIDIA GeForce RTX 4090, 24564, 5120, 37, 55, 120.45\n",
      },
      [PROC_QUERY]: { code: 0, stdout: "4711, /usr/bin/llama-server, 5120\n" },
    });
    const stats = await detectGpuStats({ platform: "linux", gpuKind: "nvidia", runner });

    expect(stats.available).toBe(true);
    if (!stats.available) return;
    expect(stats.gpus).toHaveLength(1);
    expect(stats.gpus[0]).toEqual({
      index: 0,
      name: "NVIDIA GeForce RTX 4090",
      memoryTotalBytes: 24564 * MiB,
      memoryUsedBytes: 5120 * MiB,
      utilizationPct: 37,
      temperatureC: 55,
      powerWatts: 120.45,
    });
    expect(stats.processes).toEqual([
      { pid: 4711, name: "/usr/bin/llama-server", usedBytes: 5120 * MiB },
    ]);
  });

  test("没有 nvidia-smi：reason=no-tool，且不写告警（纯 CPU 机器是最常见的情况）", async () => {
    const runner = fakeRunner({});
    const before = readAppLogsInMemory({ limit: 50 }).length;
    const stats = await detectGpuStats({ platform: "linux", gpuKind: "none", runner });

    expect(stats).toEqual({ available: false, reason: "no-tool" });
    expect(readAppLogsInMemory({ limit: 50 }).length).toBe(before);
  });

  test("命令在却答不出来：reason=probe-failed，并记一条日志（否则这一屏空白没法排查）", async () => {
    const runner = fakeRunner({
      [GPU_QUERY]: { code: 9, stdout: "", stderr: "Unable to determine the device handle" },
    });
    const stats = await detectGpuStats({ platform: "linux", gpuKind: "nvidia", runner });

    expect(stats).toEqual({ available: false, reason: "probe-failed" });
    expect(readAppLogsInMemory({ event: "hardware.gpu.stats_probe_failed" }).length).toBe(1);
  });

  test("命令成功但一张卡都没有：按「读不到」处理，不给 0 张卡的假成功", async () => {
    const runner = fakeRunner({ [GPU_QUERY]: { code: 0, stdout: "\n" } });
    const stats = await detectGpuStats({ platform: "linux", gpuKind: "nvidia", runner });

    expect(stats).toEqual({ available: false, reason: "probe-failed" });
    expect(readAppLogsInMemory({ event: "hardware.gpu.stats_empty" }).length).toBe(1);
  });

  test("逐进程那条命令失败不影响整卡数据（归属是加分项，不是前提）", async () => {
    const runner = fakeRunner({
      [GPU_QUERY]: { code: 0, stdout: "0, NVIDIA A100-SXM4-40GB, 40960, 1024, 5, 30, 70\n" },
      [PROC_QUERY]: { code: 1, stderr: "not supported on this driver" },
    });
    const stats = await detectGpuStats({ platform: "linux", gpuKind: "nvidia", runner });

    expect(stats.available).toBe(true);
    if (!stats.available) return;
    expect(stats.gpus[0]!.name).toBe("NVIDIA A100-SXM4-40GB");
    expect(stats.processes).toEqual([]);
  });
});

describe("getGpuStats 缓存", () => {
  test("注入 runner 时不读也不写缓存：两次调用各跑一次命令", async () => {
    const runner = fakeRunner({
      [GPU_QUERY]: { code: 0, stdout: "0, NVIDIA GeForce RTX 4090, 24564, 1024, 10, 40, 100\n" },
      [PROC_QUERY]: { code: 0, stdout: "" },
    });
    const options = { platform: "linux", gpuKind: "nvidia" as const, runner };
    await getGpuStats(options);
    await getGpuStats(options);

    expect(runner.calls.filter((c) => c.startsWith("nvidia-smi --query-gpu")).length).toBe(2);
  });
});
