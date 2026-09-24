import { describe, expect, test } from "bun:test";

import { readAppLogsInMemory } from "./app-log";
import { detectHardware, getHardwareInfo, type CommandRunner, type SysfsReader } from "./hardware";

/**
 * 探测路径按平台各走一遍。命令与系统信息都是注入的，不依赖跑测试的这台机器
 * —— CI 上没有 nvidia-smi、本地是 Apple 芯片，两边都要能跑到同一条断言。
 */
type Answer = { code?: number; stdout?: string; stderr?: string };

function fakeRunner(answers: Record<string, Answer>): CommandRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    run: (cmd) => {
      const key = cmd.join(" ");
      calls.push(key);
      const answer = answers[key];
      return {
        code: answer?.code ?? 127,
        stdout: answer?.stdout ?? "",
        stderr: answer?.stderr ?? `command not found: ${cmd[0]}`,
      };
    },
    // 硬件探测全是同步命令，这里不会走到流式执行
    runStreaming: async () => -1,
  };
}

/**
 * sysfs 注入口：按前缀查一张 `path → 内容` 表，没登记的返回 null（读不到）。
 * `calls` 记下每次读的 path，用来断言「根本没碰 sysfs」。
 */
function fakeSysfs(files: Record<string, string>) {
  const calls: string[] = [];
  const read: SysfsReader = (path) => {
    calls.push(path);
    const match = Object.keys(files).find((k) => path.startsWith(k));
    return match ? files[match] ?? null : null;
  };
  return { calls, read };
}

const GB = 1e9;
const GiB = 1024 ** 3;

describe("detectHardware", () => {
  test("Apple 芯片：芯片名取自 sysctl，GPU 按统一内存处理，不再跑显卡探测命令", () => {
    const runner = fakeRunner({
      "sysctl -n machdep.cpu.brand_string": { code: 0, stdout: "Apple M3 Ultra\n" },
      "sysctl -n hw.model": { code: 0, stdout: "Mac15,14\n" },
      "sysctl -n hw.physicalcpu hw.logicalcpu": { code: 0, stdout: "32\n32\n" },
    });
    const info = detectHardware({
      platform: "darwin",
      arch: "arm64",
      runner,
      cpuList: [{ model: "Apple M3 Ultra" }],
      totalMemoryBytes: 512 * GB,
      freeMemoryBytes: 100 * GB,
    });

    expect(info.chipName).toBe("Apple M3 Ultra");
    expect(info.chipVendor).toBe("apple");
    expect(info.modelId).toBe("Mac15,14");
    expect(info.cpuCores).toBe(32);
    expect(info.gpu).toEqual({ kind: "apple", name: "Apple M3 Ultra", vramBytes: null, unifiedMemory: true });
    expect(info.budgetBasis).toBe("unified");
    expect(info.budgetBytes).toBe(Math.round(512 * GB * 0.75));
    // Apple 芯片的 GPU 就是芯片本身：nvidia-smi / system_profiler 都不该被调用
    expect(runner.calls.some((c) => c.startsWith("nvidia-smi"))).toBe(false);
    expect(runner.calls.some((c) => c.startsWith("system_profiler"))).toBe(false);
  });

  test("Intel Mac：从 system_profiler 读独显与显存，预算改按显存算", () => {
    const runner = fakeRunner({
      "sysctl -n machdep.cpu.brand_string": {
        code: 0,
        stdout: "Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz\n",
      },
      "sysctl -n hw.model": { code: 0, stdout: "MacBookPro16,1\n" },
      "sysctl -n hw.physicalcpu hw.logicalcpu": { code: 0, stdout: "6\n12\n" },
      "system_profiler SPDisplaysDataType": {
        code: 0,
        stdout: "      Chipset Model: AMD Radeon Pro 5500M\n      VRAM (Total): 4 GB\n",
      },
    });
    const info = detectHardware({
      platform: "darwin",
      arch: "x64",
      runner,
      cpuList: [{ model: "Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz" }],
      totalMemoryBytes: 16 * GB,
      freeMemoryBytes: 4 * GB,
    });

    expect(info.chipVendor).toBe("intel");
    expect(info.cpuThreads).toBe(12);
    expect(info.gpu.kind).toBe("amd");
    expect(info.gpu.vramBytes).toBe(4 * GB);
    expect(info.budgetBasis).toBe("vram");
    expect(info.budgetBytes).toBe(Math.round(4 * GB * 0.9));
  });

  test("Intel Mac 读不到显卡：按未识别处理并记一条日志，预算退回内存口径", () => {
    const runner = fakeRunner({
      "sysctl -n machdep.cpu.brand_string": { code: 0, stdout: "Intel(R) Core(TM) i5-8259U\n" },
      "sysctl -n hw.model": { code: 0, stdout: "Macmini8,1\n" },
      "sysctl -n hw.physicalcpu hw.logicalcpu": { code: 0, stdout: "4\n8\n" },
      "system_profiler SPDisplaysDataType": { code: 1, stderr: "boom" },
    });
    const info = detectHardware({
      platform: "darwin",
      arch: "x64",
      runner,
      cpuList: [{ model: "Intel(R) Core(TM) i5-8259U" }],
      totalMemoryBytes: 16 * GB,
      freeMemoryBytes: 8 * GB,
    });

    expect(info.gpu.kind).toBe("unknown");
    expect(info.budgetBasis).toBe("system");
    expect(
      readAppLogsInMemory({ source: "app", event: "hardware.gpu.profiler_failed" }).length,
    ).toBeGreaterThan(0);
  });

  test("Linux + NVIDIA：显存取 nvidia-smi 的 MiB 值", () => {
    const runner = fakeRunner({
      "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits": {
        code: 0,
        stdout: "NVIDIA GeForce RTX 4090, 24564\n",
      },
    });
    const info = detectHardware({
      platform: "linux",
      arch: "x64",
      runner,
      cpuList: [{ model: "AMD Ryzen 9 7950X 16-Core Processor" }],
      totalMemoryBytes: 64 * GB,
      freeMemoryBytes: 32 * GB,
    });

    expect(info.chipVendor).toBe("amd");
    expect(info.modelId).toBeUndefined();
    expect(info.gpu).toEqual({
      kind: "nvidia",
      name: "NVIDIA GeForce RTX 4090",
      vramBytes: 24564 * 1024 * 1024,
    });
    expect(info.budgetBasis).toBe("vram");
  });

  test("Linux 没有 nvidia-smi：正常降级，不写告警（那是最常见的情况）", () => {
    const info = detectHardware({
      platform: "linux",
      arch: "x64",
      runner: fakeRunner({}),
      readSysFile: fakeSysfs({}).read,
      cpuList: [{ model: "Intel(R) Xeon(R) Silver 4110" }],
      totalMemoryBytes: 32 * GB,
      freeMemoryBytes: 8 * GB,
    });

    expect(info.gpu.kind).toBe("none");
    expect(info.budgetBasis).toBe("system");
    expect(readAppLogsInMemory({ event: "hardware.gpu.nvidia_probe_failed" })).toHaveLength(0);
  });

  test("nvidia-smi 在但驱动不对：按无独显降级，同时留下可排查的告警", () => {
    const runner = fakeRunner({
      "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits": {
        code: 9,
        stderr: "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver",
      },
    });
    const info = detectHardware({
      platform: "linux",
      arch: "x64",
      runner,
      readSysFile: fakeSysfs({}).read,
      cpuList: [{ model: "Intel(R) Xeon(R) Silver 4110" }],
      totalMemoryBytes: 32 * GB,
      freeMemoryBytes: 8 * GB,
    });

    expect(info.gpu.kind).toBe("none");
    expect(
      readAppLogsInMemory({ source: "app", event: "hardware.gpu.nvidia_probe_failed" }).length,
    ).toBeGreaterThan(0);
  });

  test("sysctl 读不到芯片名时回落到 CPU 上报的型号，并记一条告警", () => {
    const runner = fakeRunner({});
    const info = detectHardware({
      platform: "darwin",
      arch: "x64",
      runner,
      cpuList: [{ model: "Intel(R) Core(TM) i7-8850H CPU @ 2.60GHz" }],
      totalMemoryBytes: 32 * GB,
      freeMemoryBytes: 16 * GB,
    });

    expect(info.chipName).toBe("Intel(R) Core(TM) i7-8850H CPU @ 2.60GHz");
    expect(info.chipVendor).toBe("intel");
    expect(
      readAppLogsInMemory({ source: "app", event: "hardware.chip.probe_failed" }).length,
    ).toBeGreaterThan(0);
  });
});

describe("detectHardware AMD (ROCm)", () => {
  const linux = (options: {
    runner?: CommandRunner;
    sysfs?: { calls: string[]; read: SysfsReader };
    total?: number;
  } = {}) =>
    detectHardware({
      platform: "linux",
      arch: "x64",
      runner: options.runner ?? fakeRunner({}),
      readSysFile: (options.sysfs ?? fakeSysfs({})).read,
      cpuList: [{ model: "AMD Ryzen AI MAX+ 395" }],
      totalMemoryBytes: options.total ?? 128 * GB,
      freeMemoryBytes: 64 * GB,
    });

  test("本机这台 APU：sysfs 专用分区 512MiB + GTT 120GiB → 统一内存，vramBytes 给 null", () => {
    const sysfs = fakeSysfs({
      "/sys/class/drm/card0/device/mem_info_vram_total": "536870912",
      "/sys/class/drm/card0/device/mem_info_gtt_total": "128849018880",
      "/sys/class/drm/card0/device/uevent":
        "DRIVER=amdgpu\nPCI_ID=1002:1586\nPCI_SLOT_NAME=0000:c6:00.0\nMODALIAS=pci:v00001002d00001586sv00001F66sd00000030bc03sc80i00\n",
      "/sys/class/drm/card0/device/vendor": "0x1002\n",
    });
    const info = detectHardware({
      platform: "linux",
      arch: "x64",
      runner: fakeRunner({}),
      readSysFile: sysfs.read,
      cpuList: [{ model: "AMD Ryzen AI MAX+ 395" }],
      totalMemoryBytes: 128 * GB,
      freeMemoryBytes: 64 * GB,
    });

    expect(info.gpu.kind).toBe("amd");
    expect(info.gpu.unifiedMemory).toBe(true);
    expect(info.gpu.vramBytes).toBeNull();
    expect(info.gpu.name).toBe("amdgpu (1002:1586)");
    expect(info.budgetBasis).toBe("unified");
    expect(info.budgetBytes).toBe(Math.round(128 * GB * 0.75));
  });

  test("真独显（24GiB、无 GTT 文件）：vramBytes 照旧，unifiedMemory false，预算按显存", () => {
    const sysfs = fakeSysfs({
      "/sys/class/drm/card0/device/mem_info_vram_total": String(24 * GiB),
      "/sys/class/drm/card0/device/uevent": "DRIVER=amdgpu\nPCI_ID=1002:740c\n",
    });
    const info = detectHardware({
      platform: "linux",
      arch: "x64",
      runner: fakeRunner({}),
      readSysFile: sysfs.read,
      cpuList: [{ model: "AMD Ryzen 9 7950X" }],
      totalMemoryBytes: 64 * GB,
      freeMemoryBytes: 32 * GB,
    });

    expect(info.gpu).toEqual({
      kind: "amd",
      name: "amdgpu (1002:740c)",
      vramBytes: 24 * GiB,
      unifiedMemory: false,
    });
    expect(info.budgetBasis).toBe("vram");
    expect(info.budgetBytes).toBe(Math.round(24 * GiB * 0.9));
  });

  test("小显存但 GTT 也小（1GiB / 0）：仍判统一内存（走 2GiB 阈值那一支）", () => {
    const sysfs = fakeSysfs({
      "/sys/class/drm/card0/device/mem_info_vram_total": String(GiB),
      "/sys/class/drm/card0/device/uevent": "DRIVER=amdgpu\nPCI_ID=1002:1234\n",
    });
    const info = detectHardware({
      platform: "linux",
      arch: "x64",
      runner: fakeRunner({}),
      readSysFile: sysfs.read,
      cpuList: [{ model: "AMD Ryzen 7" }],
      totalMemoryBytes: 32 * GB,
      freeMemoryBytes: 16 * GB,
    });

    expect(info.gpu.kind).toBe("amd");
    expect(info.gpu.unifiedMemory).toBe(true);
    expect(info.gpu.vramBytes).toBeNull();
    expect(info.budgetBasis).toBe("unified");
  });

  test("sysfs 全读不到、rocm-smi 有输出：从 JSON 解析，走同样的判定", () => {
    const runner = fakeRunner({
      "rocm-smi --showmeminfo vram --json": {
        code: 0,
        stdout: JSON.stringify({
          card0: { "VRAM Total Memory (B)": "536870912", "VRAM Total Used Memory (B)": "490381312" },
        }),
      },
    });
    const info = detectHardware({
      platform: "linux",
      arch: "x64",
      runner,
      readSysFile: fakeSysfs({}).read,
      cpuList: [{ model: "AMD Ryzen AI MAX+ 395" }],
      totalMemoryBytes: 128 * GB,
      freeMemoryBytes: 64 * GB,
    });

    expect(info.gpu.kind).toBe("amd");
    expect(info.gpu.name).toBe("AMD GPU (card0)");
    expect(info.gpu.unifiedMemory).toBe(true);
    expect(info.gpu.vramBytes).toBeNull();
  });

  test("sysfs 和 rocm-smi 都没有：保持现有 none 行为，不抛异常、不记 AMD 告警", () => {
    const info = linux();
    expect(info.gpu.kind).toBe("none");
    expect(info.budgetBasis).toBe("system");
    expect(readAppLogsInMemory({ event: "hardware.gpu.amd_probe_failed" })).toHaveLength(0);
  });

  test("NVIDIA 优先：nvidia-smi 有输出时不碰 AMD 探测（sysfs 一次都没被读）", () => {
    const sysfs = fakeSysfs({
      "/sys/class/drm/card0/device/mem_info_vram_total": "536870912",
    });
    const runner = fakeRunner({
      "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits": {
        code: 0,
        stdout: "NVIDIA GeForce RTX 4090, 24564\n",
      },
    });
    const info = detectHardware({
      platform: "linux",
      arch: "x64",
      runner,
      readSysFile: sysfs.read,
      cpuList: [{ model: "AMD Ryzen 9 7950X" }],
      totalMemoryBytes: 64 * GB,
      freeMemoryBytes: 32 * GB,
    });

    expect(info.gpu.kind).toBe("nvidia");
    expect(sysfs.calls).toHaveLength(0);
    expect(runner.calls.some((c) => c.startsWith("rocm-smi"))).toBe(false);
  });

  test("多张卡：card0 报 512MiB、card1 报 16GiB → 选 card1，unifiedMemory false", () => {
    const sysfs = fakeSysfs({
      "/sys/class/drm/card0/device/mem_info_vram_total": "536870912",
      "/sys/class/drm/card0/device/mem_info_gtt_total": "128849018880",
      "/sys/class/drm/card0/device/uevent": "DRIVER=amdgpu\nPCI_ID=1002:1586\n",
      "/sys/class/drm/card1/device/mem_info_vram_total": String(16 * GiB),
      "/sys/class/drm/card1/device/uevent": "DRIVER=amdgpu\nPCI_ID=1002:7442\n",
    });
    const info = detectHardware({
      platform: "linux",
      arch: "x64",
      runner: fakeRunner({}),
      readSysFile: sysfs.read,
      cpuList: [{ model: "AMD Ryzen 9" }],
      totalMemoryBytes: 64 * GB,
      freeMemoryBytes: 32 * GB,
    });

    expect(info.gpu.kind).toBe("amd");
    expect(info.gpu.name).toBe("amdgpu (1002:7442)");
    expect(info.gpu.vramBytes).toBe(16 * GiB);
    expect(info.gpu.unifiedMemory).toBe(false);
  });
});

describe("getHardwareInfo", () => {
  test("首次探测后走缓存；refresh 时才重新探测（本机的真实探测结果）", () => {
    const first = getHardwareInfo();
    expect(getHardwareInfo()).toBe(first);
    expect(first.totalMemoryBytes).toBeGreaterThan(0);
    expect(first.budgetBytes).toBeGreaterThan(0);
    expect(first.budgetBytes).toBeLessThanOrEqual(first.totalMemoryBytes);
    expect(first.chipName.length).toBeGreaterThan(0);
    expect(first.cpuCores).toBeGreaterThanOrEqual(1);

    const refreshed = getHardwareInfo({ refresh: true });
    expect(refreshed).not.toBe(first);
    expect(refreshed.totalMemoryBytes).toBe(first.totalMemoryBytes);
  });
});
