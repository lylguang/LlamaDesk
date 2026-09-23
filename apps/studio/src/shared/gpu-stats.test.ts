import { describe, expect, test } from "bun:test";

import {
  gpuStatsUnavailableReason,
  parseNvidiaSmiProcesses,
  parseNvidiaSmiSamples,
  processVram,
  splitNvidiaSmiFields,
} from "./gpu-stats";

const MiB = 1024 * 1024;

describe("splitNvidiaSmiFields", () => {
  test("按「逗号 + 空格」拆，并去掉两边的空格", () => {
    expect(splitNvidiaSmiFields("0, NVIDIA GeForce RTX 4090, 24564")).toEqual([
      "0",
      "NVIDIA GeForce RTX 4090",
      "24564",
    ]);
  });

  test("字段里的逗号不拆：卡名带逗号时直接用 split(',') 会让后面所有列错位", () => {
    expect(splitNvidiaSmiFields('1, "NVIDIA RTX A4000, 16GB", 16376, 0')).toEqual([
      "1",
      "NVIDIA RTX A4000, 16GB",
      "16376",
      "0",
    ]);
  });
});

describe("parseNvidiaSmiSamples", () => {
  test("单卡：七个字段各就各位，显存 MiB → bytes", () => {
    const samples = parseNvidiaSmiSamples("0, NVIDIA GeForce RTX 4090, 24564, 5120, 37, 55, 120.45\n");
    expect(samples).toEqual([
      {
        index: 0,
        name: "NVIDIA GeForce RTX 4090",
        memoryTotalBytes: 24564 * MiB,
        memoryUsedBytes: 5120 * MiB,
        utilizationPct: 37,
        temperatureC: 55,
        powerWatts: 120.45,
      },
    ]);
  });

  test("多卡：按行各给一张，不合并", () => {
    const samples = parseNvidiaSmiSamples(
      "0, NVIDIA GeForce RTX 4090, 24564, 5120, 37, 55, 120.45\n" +
        "1, NVIDIA GeForce RTX 4090, 24564, 1024, 0, 41, 30.2\n",
    );
    expect(samples.map((s) => [s.index, s.memoryUsedBytes, s.utilizationPct])).toEqual([
      [0, 5120 * MiB, 37],
      [1, 1024 * MiB, 0],
    ]);
  });

  test("[N/A] 与 [Not Supported]：认不出的字段给 null，其余字段照旧（虚拟机 / 消费卡常见）", () => {
    const samples = parseNvidiaSmiSamples("0, Tesla T4, 15360, [N/A], [N/A], [Not Supported], [N/A]\n");
    expect(samples).toEqual([
      {
        index: 0,
        name: "Tesla T4",
        memoryTotalBytes: 15360 * MiB,
        memoryUsedBytes: null,
        utilizationPct: null,
        temperatureC: null,
        powerWatts: null,
      },
    ]);
  });

  test("空行与提示文字跳过，不是卡的行不会被当成卡（否则界面会画出一张假卡）", () => {
    const samples = parseNvidiaSmiSamples(
      "\nNo devices were found\n0, NVIDIA RTX A6000, 49140, 2048, 12, 62, 150\n\n",
    );
    expect(samples).toHaveLength(1);
    expect(samples[0]!.name).toBe("NVIDIA RTX A6000");
  });

  test("认不出任何卡：返回空数组（调用方据此判定「读不到」，而不是 0 张卡的成功）", () => {
    expect(parseNvidiaSmiSamples("")).toEqual([]);
  });
});

describe("parseNvidiaSmiProcesses", () => {
  test("pid + 进程名 + 显存：进程名带逗号也不会把名字读成显存", () => {
    const procs = parseNvidiaSmiProcesses(
      "4711, /opt/homebrew/bin/llama-server, 5120\n" +
        '4712, "python3 -m vllm.entrypoints, worker", 20480\n',
    );
    expect(procs).toEqual([
      { pid: 4711, name: "/opt/homebrew/bin/llama-server", usedBytes: 5120 * MiB },
      { pid: 4712, name: "python3 -m vllm.entrypoints, worker", usedBytes: 20480 * MiB },
    ]);
  });

  test("没有计算进程时是空输出（正常情况：模型还没起来）", () => {
    expect(parseNvidiaSmiProcesses("")).toEqual([]);
  });
});

describe("processVram", () => {
  test("按 pid 汇总；同一 pid 出现多次相加而不是覆盖", () => {
    const totals = processVram([
      { pid: 1, name: "a", usedBytes: 100 },
      { pid: 1, name: "a", usedBytes: 50 },
      { pid: 2, name: "b", usedBytes: 7 },
    ]);
    expect(totals.get(1)).toBe(150);
    expect(totals.get(2)).toBe(7);
    expect(totals.get(3)).toBeUndefined();
  });
});

describe("gpuStatsUnavailableReason", () => {
  test("Apple 芯片优先判统一内存（与有没有 nvidia-smi 无关）", () => {
    expect(
      gpuStatsUnavailableReason({ platform: "darwin", gpuKind: "apple", commandMissing: true }),
    ).toBe("unified-memory");
  });

  test("非 Apple 的 Mac 是「nvidia-smi 不适用」，不是「没装」", () => {
    expect(
      gpuStatsUnavailableReason({ platform: "darwin", gpuKind: "amd", commandMissing: true }),
    ).toBe("non-nvidia");
  });

  test("Linux / Windows：命令缺失与命令失败分开（前者不给告警，后者要记日志）", () => {
    expect(
      gpuStatsUnavailableReason({ platform: "linux", gpuKind: "none", commandMissing: true }),
    ).toBe("no-tool");
    expect(
      gpuStatsUnavailableReason({ platform: "linux", gpuKind: "nvidia", commandMissing: false }),
    ).toBe("probe-failed");
  });
});
