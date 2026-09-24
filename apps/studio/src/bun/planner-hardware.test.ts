import { afterEach, describe, expect, mock, test } from "bun:test";

import { detectHardware, type CommandRunner } from "./hardware";
import { detectGpuStats, type GpuCommandRunner } from "./gpu-stats";
import { plannerHardwareSnapshot } from "./planner-hardware";

/**
 * `plannerHardwareSnapshot` 组装的三条分支（统一内存 / NVIDIA / 其它独显）各走一遍。
 *
 * 注入方式：`getHardwareInfo` / `getGpuStats` 都没有直接的注入口（前者走 `detectHardware`
 * 的 runner，后者走 `detectGpuStats` 的 runner），这里 `mock.module` 把两个模块替换成
 * 返回固定数据的桩 —— 桩只覆盖被测的那一个函数，其余导出原样透传。
 */

const hardwareModule = "./hardware";
const gpuStatsModule = "./gpu-stats";

// 保存真实模块，afterAll 时恢复（bun 的 mock.module 跨文件泄漏，收尾必须还原）。
const realHardware = await import("./hardware");
const realGpuStats = await import("./gpu-stats");

function fakeHardwareRunner(answers: Record<string, { code?: number; stdout?: string; stderr?: string }>): CommandRunner {
  const run: CommandRunner["run"] = (cmd) => {
    const key = cmd.join(" ");
    const answer = answers[key];
    return {
      code: answer?.code ?? 127,
      stdout: answer?.stdout ?? "",
      stderr: answer?.stderr ?? `command not found: ${cmd[0]}`,
    };
  };
  return { run, runStreaming: async () => -1 };
}

/** Apple Silicon 画像（统一内存）。 */
function appleHardware() {
  return detectHardware({
    platform: "darwin",
    arch: "arm64",
    runner: fakeHardwareRunner({
      "sysctl -n machdep.cpu.brand_string": { code: 0, stdout: "Apple M3 Ultra\n" },
      "sysctl -n hw.physicalcpu hw.logicalcpu": { code: 0, stdout: "8\n16\n" },
    }),
    cpuList: [{ model: "Apple M3 Ultra" }],
    totalMemoryBytes: 128 * 1024 ** 3,
    freeMemoryBytes: 64 * 1024 ** 3,
  });
}

/** AMD APU（统一内存，T4a 加的分支）。 */
function amdApuHardware() {
  return detectHardware({
    platform: "linux",
    arch: "x64",
    runner: fakeHardwareRunner({}),
    readSysFile: (path) => {
      if (path.endsWith("mem_info_vram_total")) return "536870912";
      if (path.endsWith("mem_info_gtt_total")) return "128849018880";
      if (path.endsWith("uevent")) return "DRIVER=amdgpu\nPCI_ID=1002:1586\n";
      if (path.endsWith("vendor")) return "0x1002";
      return null;
    },
    cpuList: [{ model: "AMD Ryzen AI MAX+ 395" }],
    totalMemoryBytes: 128 * 1024 ** 3,
    freeMemoryBytes: 64 * 1024 ** 3,
  });
}

/** NVIDIA 独显画像（vramBytes 是总量 24GB）。 */
function nvidiaHardware() {
  return detectHardware({
    platform: "linux",
    arch: "x64",
    runner: fakeHardwareRunner({
      "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits": {
        code: 0,
        stdout: "NVIDIA GeForce RTX 4090, 24564\n",
      },
    }),
    readSysFile: () => null,
    cpuList: [{ model: "AMD Ryzen 9 7950X" }],
    totalMemoryBytes: 64 * 1024 ** 3,
    freeMemoryBytes: 32 * 1024 ** 3,
  });
}

/** 没有 GPU 的机器。 */
function noGpuHardware() {
  return detectHardware({
    platform: "linux",
    arch: "x64",
    runner: fakeHardwareRunner({}),
    readSysFile: () => null,
    cpuList: [{ model: "Intel(R) Xeon(R)" }],
    totalMemoryBytes: 64 * 1024 ** 3,
    freeMemoryBytes: 32 * 1024 ** 3,
  });
}

function stubHardware(hw: unknown) {
  mock.module(hardwareModule, () => ({
    ...realHardware,
    getHardwareInfo: () => hw,
  }));
}

function fakeGpuRunner(answers: Record<string, { code?: number; stdout?: string; stderr?: string }>): GpuCommandRunner {
  return {
    run: async (cmd) => {
      const key = cmd.join(" ");
      const answer = answers[key];
      return {
        code: answer?.code ?? 127,
        stdout: answer?.stdout ?? "",
        stderr: answer?.stderr ?? `command not found: ${cmd[0]}`,
      };
    },
  };
}

function stubGpuStats(result: unknown) {
  mock.module(gpuStatsModule, () => ({
    ...realGpuStats,
    getGpuStats: async () => result,
  }));
}

afterEach(() => {
  // 还原真实模块，避免 mock 泄漏到下一个测试文件。
  mock.module(hardwareModule, () => realHardware);
  mock.module(gpuStatsModule, () => realGpuStats);
});

describe("plannerHardwareSnapshot", () => {
  test("Apple Silicon（统一内存）→ vramFree/Total 都 null，unifiedMemory true", async () => {
    stubHardware(appleHardware());
    stubGpuStats({ available: false, reason: "unified-memory" });
    const hw = await plannerHardwareSnapshot();
    expect(hw.unifiedMemory).toBe(true);
    expect(hw.hasGpu).toBe(true);
    expect(hw.vramFreeBytes).toBeNull();
    expect(hw.vramTotalBytes).toBeNull();
    expect(hw.systemTotalBytes).toBe(128 * 1024 ** 3);
    expect(hw.systemFreeBytes).toBe(64 * 1024 ** 3);
    expect(hw.cpuThreads).toBe(16);
  });

  test("AMD APU（T4a 的分支，统一内存）→ 同样 null/null，unifiedMemory true", async () => {
    stubHardware(amdApuHardware());
    stubGpuStats({ available: false, reason: "no-tool" });
    const hw = await plannerHardwareSnapshot();
    expect(hw.unifiedMemory).toBe(true);
    expect(hw.hasGpu).toBe(true);
    expect(hw.vramFreeBytes).toBeNull();
    expect(hw.vramTotalBytes).toBeNull();
  });

  test("NVIDIA + gpu-stats 有数据 → free = total - used（取最大卡）", async () => {
    stubHardware(nvidiaHardware());
    const total24 = 24 * 1024 ** 2;
    const used10 = 10 * 1024 ** 2;
    const total16 = 16 * 1024 ** 2;
    const used8 = 8 * 1024 ** 2;
    stubGpuStats({
      available: true,
      gpus: [
        { index: 0, name: "RTX A4000", memoryTotalBytes: total16, memoryUsedBytes: used8, utilizationPct: null, temperatureC: null, powerWatts: null },
        { index: 1, name: "RTX 4090", memoryTotalBytes: total24, memoryUsedBytes: used10, utilizationPct: null, temperatureC: null, powerWatts: null },
      ],
      processes: [],
    });
    const hw = await plannerHardwareSnapshot();
    expect(hw.unifiedMemory).toBe(false);
    expect(hw.hasGpu).toBe(true);
    // 取最大卡（24GB）
    expect(hw.vramTotalBytes).toBe(total24);
    expect(hw.vramFreeBytes).toBe(total24 - used10);
  });

  test("NVIDIA 但 gpu-stats 读不到（超时/无 nvidia-smi/空输出）→ free null，total 回落到 gpu.vramBytes", async () => {
    stubHardware(nvidiaHardware());
    stubGpuStats({ available: false, reason: "probe-failed" });
    const hw = await plannerHardwareSnapshot();
    expect(hw.unifiedMemory).toBe(false);
    expect(hw.hasGpu).toBe(true);
    expect(hw.vramFreeBytes).toBeNull();
    // 总量从机器画像拿（nvidia-smi 的 memory.total，MiB → bytes）
    expect(hw.vramTotalBytes).toBe(24564 * 1024 * 1024);
  });

  test("AMD 独显（非统一内存）→ total 用 gpu.vramBytes，free 无采样通道 → null", async () => {
    const hwInfo = detectHardware({
      platform: "linux",
      arch: "x64",
      runner: fakeHardwareRunner({}),
      readSysFile: (path) => {
        if (path.endsWith("mem_info_vram_total")) return String(24 * 1024 ** 3);
        if (path.endsWith("uevent")) return "DRIVER=amdgpu\nPCI_ID=1002:740c\n";
        return null;
      },
      cpuList: [{ model: "AMD Ryzen 9 7950X" }],
      totalMemoryBytes: 64 * 1024 ** 3,
      freeMemoryBytes: 32 * 1024 ** 3,
    });
    expect(hwInfo.gpu.unifiedMemory).toBe(false);
    expect(hwInfo.gpu.vramBytes).toBe(24 * 1024 ** 3);
    stubHardware(hwInfo);
    stubGpuStats({ available: false, reason: "no-tool" });
    const hw = await plannerHardwareSnapshot();
    expect(hw.unifiedMemory).toBe(false);
    expect(hw.hasGpu).toBe(true);
    expect(hw.vramTotalBytes).toBe(24 * 1024 ** 3);
    expect(hw.vramFreeBytes).toBeNull();
  });

  test("kind === none（无 GPU）→ hasGpu false，vram 全 null", async () => {
    stubHardware(noGpuHardware());
    stubGpuStats({ available: false, reason: "no-tool" });
    const hw = await plannerHardwareSnapshot();
    expect(hw.hasGpu).toBe(false);
    expect(hw.unifiedMemory).toBe(false);
    expect(hw.vramFreeBytes).toBeNull();
    expect(hw.vramTotalBytes).toBeNull();
  });
});
