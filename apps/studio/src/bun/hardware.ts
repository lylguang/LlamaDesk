import { readFileSync } from "node:fs";
import { cpus, freemem, totalmem } from "node:os";

import {
  AMD_DEDICATED_VRAM_MIN_BYTES,
  classifyChipVendor,
  inferenceMemoryBudget,
  parseDisplaysChipset,
  parseNvidiaSmiOutput,
  type ChipVendor,
  type GpuInfo,
  type HardwareInfo,
} from "../shared/hardware";
import { logEvent } from "./app-log";
import { DEFAULT_COMMAND_TIMEOUT_MS, defaultCommandRunner, type CommandRunner } from "./command-runner";

/**
 * 机器画像探测：芯片名、核数、内存、显卡（型号 + 显存）。
 *
 * 只用系统自带命令，全部同步且带超时，失败一律降级而不是抛错（引导页不能因为少一条
 * 命令就卡住）：
 *  - macOS：`sysctl -n machdep.cpu.brand_string` —— Apple 芯片直接回 `Apple M3 Ultra`，
 *    Intel 机回 CPU 型号；只有 Intel 机才去跑 `system_profiler SPDisplaysDataType`
 *    （秒级，为了拿独显型号与显存），Apple 芯片的 GPU 就是芯片本身，不必再跑。
 *  - Linux / Windows：`nvidia-smi` 查独显（显存决定 vLLM 能跑多大），其余走 node:os。
 *
 * 命令与系统信息都可注入，探测路径在测试里用假 runner 走一遍（`bun/hardware.test.ts`），
 * 不用依赖跑测试的那台机器长什么样。
 */

const CHIP_TIMEOUT_MS = DEFAULT_COMMAND_TIMEOUT_MS;
/** system_profiler 是秒级命令，给宽一点，超时也要能继续（显存缺失只影响预算口径）。 */
const PROFILER_TIMEOUT_MS = 8_000;

export type { CommandRunner } from "./command-runner";

const defaultRunner: CommandRunner = defaultCommandRunner;

/**
 * sysfs 读文件注入口：返回 null 表示读不到（文件不存在 / 无权限），不抛。
 * AMD 探测的判定全靠 `/sys/class/drm/cardN/device/`，测试把假 reader 传进来，
 * 不依赖跑测试的机器上有没有 amdgpu。
 */
export type SysfsReader = (path: string) => string | null;

const defaultSysfsReader: SysfsReader = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

export type DetectHardwareOptions = {
  platform?: string;
  arch?: string;
  /** `node:os` 的 cpus() 结果（只要 model 字段）。 */
  cpuList?: { model: string }[];
  totalMemoryBytes?: number;
  freeMemoryBytes?: number;
  runner?: CommandRunner;
  /** sysfs 读文件（AMD 探测用），默认 `node:fs` 的 readFileSync（包了 try/catch）。 */
  readSysFile?: SysfsReader;
};

/** macOS 的芯片名：Apple 芯片与 Intel 机都由这一条给出（`hw.model` 另取机型标识）。 */
function readMacChipName(runner: CommandRunner): string | null {
  const res = runner.run(["sysctl", "-n", "machdep.cpu.brand_string"]);
  const value = res.stdout.trim().split("\n")[0]?.trim();
  if (res.code !== 0 || !value) {
    logEvent({
      level: "warn",
      source: "app",
      event: "hardware.chip.probe_failed",
      message: "sysctl machdep.cpu.brand_string 读取失败，芯片名回落到 CPU 上报的型号",
      detail: { code: res.code, stderr: res.stderr.trim() },
    });
    return null;
  }
  return value;
}

function readMacModelId(runner: CommandRunner): string | undefined {
  const res = runner.run(["sysctl", "-n", "hw.model"]);
  const value = res.stdout.trim();
  return res.code === 0 && value ? value : undefined;
}

/** 物理核 / 逻辑核：`node:os` 只给逻辑核数（Apple 芯片上还会漏掉 P/E 的差别）。 */
function readMacCpuCounts(runner: CommandRunner): { physical: number; logical: number } | null {
  const res = runner.run(["sysctl", "-n", "hw.physicalcpu", "hw.logicalcpu"]);
  if (res.code !== 0) return null;
  const [physical, logical] = res.stdout.trim().split(/\s+/).map((v) => Number.parseInt(v, 10));
  if (!physical || !logical) return null;
  return { physical, logical };
}

/**
 * 独显：`nvidia-smi` 能答就用它（显存是这里的头等目标）。命令不存在是常态
 * （Mac / 纯 CPU 机器），只有「命令在却答不出来」才值得记一条日志。
 */
function detectNvidiaGpu(runner: CommandRunner): GpuInfo | null {
  const res = runner.run([
    "nvidia-smi",
    "--query-gpu=name,memory.total",
    "--format=csv,noheader,nounits",
  ]);
  if (res.code !== 0) {
    const missing = /not found|no such file|enoent/i.test(res.stderr);
    if (!missing && res.stderr.trim()) {
      logEvent({
        level: "warn",
        source: "app",
        event: "hardware.gpu.nvidia_probe_failed",
        message: "nvidia-smi 探测失败，按无独显处理",
        detail: { code: res.code, stderr: res.stderr.trim() },
      });
    }
    return null;
  }
  return parseNvidiaSmiOutput(res.stdout);
}

/**
 * AMD（ROCm）GPU 探测，只跑在 Linux（Windows 的 ROCm 情况复杂这次不碰，macOS 没有 ROCm）。
 * 优先读 sysfs（不装任何东西、不 spawn 进程）：`mem_info_vram_total` 是 amdgpu 驱动特有的文件，
 * 本身就是「这是一张 amdgpu」的证据；`mem_info_gtt_total` 是与系统共享的内存。
 * sysfs 一无所获才退回 `rocm-smi`。
 *
 * 三个来源会报出三个不同的数（本机 Strix Halo：sysfs 专用分区 512 MiB / GTT 120 GiB /
 * llama.cpp 自己看到 125 GiB），所以先判统一内存：GTT 很大（>= 4 倍专用分区）、或专用分区
 * 低于 2 GiB（APU 的特征，真正的独显不可能这么小）。统一内存的 `vramBytes` 给 null——
 * 这块「显存」不是独立预算，让上层走系统内存口径（`inferenceMemoryBudget` 会认
 * `unifiedMemory`），否则拿 512 MiB 当预算会让规划器以为什么都跑不了。
 */
function detectAmdGpu(runner: CommandRunner, readSysFile: SysfsReader): GpuInfo | null {
  type CardInfo = {
    name: string;
    vramTotal: number;
    gttTotal: number;
  };

  const readCard = (n: number): CardInfo | null => {
    const base = `/sys/class/drm/card${n}/device/`;
    const vramRaw = readSysFile(`${base}mem_info_vram_total`);
    const vramTotal = vramRaw ? Number.parseInt(vramRaw.trim(), 10) : NaN;
    if (!Number.isFinite(vramTotal) || vramTotal <= 0) return null;
    const gttRaw = readSysFile(`${base}mem_info_gtt_total`);
    const gttTotal = gttRaw ? Number.parseInt(gttRaw.trim(), 10) : 0;

    const uevent = readSysFile(`${base}uevent`) ?? "";
    const vendor = (readSysFile(`${base}vendor`) ?? "").trim();
    // 只认 amdgpu 的卡：uevent 里有 DRIVER=amdgpu，或 PCI vendor 是 0x1002；
    // 两个都拿不到时，mem_info_vram_total 本身就是 amdgpu 特有的，也接受。
    const hasIdentity = readSysFile(`${base}vendor`) !== null || readSysFile(`${base}uevent`) !== null;
    if (uevent.includes("DRIVER=amdgpu") || vendor === "0x1002" || !hasIdentity) {
      // 卡的名字：product_name 在很多机器上不存在（本机 Strix Halo 就没有），不要依赖它；
      // 依次退回 uevent 的 PCI_ID= / DRIVER=，最后给一个通用名。
      let name = (readSysFile(`${base}product_name`) ?? "").trim();
      if (!name) {
        const pcid = /PCI_ID=([0-9a-f:]+)/i.exec(uevent)?.[1];
        const driver = /DRIVER=([A-Za-z0-9_-]+)/.exec(uevent)?.[1];
        name = pcid && driver ? `${driver} (${pcid})` : driver ?? "AMD GPU";
      }
      return { name, vramTotal, gttTotal: Number.isFinite(gttTotal) && gttTotal > 0 ? gttTotal : 0 };
    }
    return null;
  };

  let cards: CardInfo[] = [];
  for (let n = 0; n < 8; n++) {
    const card = readCard(n);
    if (card) cards.push(card);
  }

  // sysfs 一无所获才跑 rocm-smi（JSON，字段可能是字符串也可能是数字；
  // 它给不出 GTT，统一内存判定只走「专用分区 < 2 GiB」那一支）。
  if (cards.length === 0) {
    const res = runner.run(["rocm-smi", "--showmeminfo", "vram", "--json"], 10_000);
    if (res.code === 0 && res.stdout.trim()) {
      let parsedOk = false;
      try {
        const parsed: unknown = JSON.parse(res.stdout);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (!value || typeof value !== "object" || Array.isArray(value)) continue;
            const entry = value as Record<string, unknown>;
            const total = entry["VRAM Total Memory (B)"];
            const bytes =
              typeof total === "number" ? total : typeof total === "string" ? Number.parseFloat(total) : NaN;
            if (!Number.isFinite(bytes) || bytes <= 0) continue;
            parsedOk = true;
            const name =
              typeof entry["Card Series"] === "string" && entry["Card Series"]
                ? entry["Card Series"]
                : `AMD GPU (${key})`;
            cards.push({ name, vramTotal: Math.round(bytes), gttTotal: 0 });
          }
        }
      } catch (err) {
        logEvent({
          level: "warn",
          source: "app",
          event: "hardware.gpu.amd_probe_failed",
          message: "rocm-smi 输出解析失败，AMD 显存未知",
          detail: { error: err instanceof Error ? err.message : String(err), stdout: res.stdout.slice(0, 200) },
        });
      }
      if (!parsedOk) {
        // JSON 能解析但一行显存都读不出来：工具在、数据坏了，留一条可排查的告警。
        logEvent({
          level: "warn",
          source: "app",
          event: "hardware.gpu.amd_probe_failed",
          message: "rocm-smi 有输出但解析不出显存，AMD 显存未知",
          detail: { code: res.code, stdout: res.stdout.slice(0, 200) },
        });
      }
    }
  }
  if (cards.length === 0) {
    // 没有 AMD 卡是常态，不记日志，也不去碰 rocm-smi（sysfs 已经说清楚了）。
    return null;
  }

  const best = cards.reduce((a, b) => (b.vramTotal > a.vramTotal ? b : a));
  // 统一内存判定：GTT（共享系统内存）很大且 >= 4 倍专用分区（APU 的典型形状），
  // 或专用分区低于 2 GiB（APU 分区，真独显不可能这么小）。
  const unified =
    (best.gttTotal > 0 && (best.vramTotal <= 0 || best.gttTotal >= best.vramTotal * 4)) ||
    (best.vramTotal > 0 && best.vramTotal < AMD_DEDICATED_VRAM_MIN_BYTES);
  return unified
    ? { kind: "amd", name: best.name, vramBytes: null, unifiedMemory: true }
    : { kind: "amd", name: best.name, vramBytes: best.vramTotal, unifiedMemory: false };
}

/** Intel Mac 的独显（AMD / Intel 核显）与显存，只能从 system_profiler 里读。 */
function detectMacDiscreteGpu(runner: CommandRunner): GpuInfo | null {
  const res = runner.run(["system_profiler", "SPDisplaysDataType"], PROFILER_TIMEOUT_MS);
  if (res.code !== 0) {
    logEvent({
      level: "warn",
      source: "app",
      event: "hardware.gpu.profiler_failed",
      message: "system_profiler 读取显卡失败，显存未知",
      detail: { code: res.code, stderr: res.stderr.trim() },
    });
    return null;
  }
  return parseDisplaysChipset(res.stdout);
}

function detectGpu(
  platform: string,
  arch: string,
  chipName: string,
  chipVendor: ChipVendor,
  runner: CommandRunner,
  readSysFile: SysfsReader,
): GpuInfo {
  // Apple 芯片：GPU 就是芯片本身，统一内存即显存，不必再跑任何命令。
  if (platform === "darwin" && (arch === "arm64" || chipVendor === "apple")) {
    return { kind: "apple", name: chipName, vramBytes: null, unifiedMemory: true };
  }
  const nvidia = detectNvidiaGpu(runner);
  if (nvidia) return nvidia;
  // AMD（ROCm）：只在 Linux 上探测（Windows 的 ROCm 情况复杂这次不碰，macOS 没有 ROCm）。
  // 插在 NVIDIA 之后：独显机器行为不变，NVIDIA 优先。
  if (platform === "linux") {
    const amd = detectAmdGpu(runner, readSysFile);
    if (amd) return amd;
  }
  if (platform === "darwin") {
    return detectMacDiscreteGpu(runner) ?? { kind: "unknown", name: "未识别显卡", vramBytes: null };
  }
  return { kind: "none", name: "未检测到独立显卡", vramBytes: null };
}

export function detectHardware(options: DetectHardwareOptions = {}): HardwareInfo {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const runner = options.runner ?? defaultRunner;
  const readSysFile = options.readSysFile ?? defaultSysfsReader;
  const cpuList = options.cpuList ?? cpus();
  const totalMemoryBytes = options.totalMemoryBytes ?? totalmem();
  const freeMemoryBytes = options.freeMemoryBytes ?? freemem();

  const chipName = (platform === "darwin" ? readMacChipName(runner) : null) ?? cpuList[0]?.model?.trim() ?? arch;
  const chipVendor = classifyChipVendor(chipName);
  const gpu = detectGpu(platform, arch, chipName, chipVendor, runner, readSysFile);
  const { budgetBytes, basis } = inferenceMemoryBudget({ gpu, totalMemoryBytes });
  // 非 macOS 平台拿不到物理核数（`node:os` 只给逻辑核），退回逻辑核数并如实标注。
  const cores = platform === "darwin" ? readMacCpuCounts(runner) : null;
  const cpuThreads = Math.max(1, cores?.logical ?? cpuList.length);

  const info: HardwareInfo = {
    platform,
    arch,
    chipName,
    chipVendor,
    modelId: platform === "darwin" ? readMacModelId(runner) : undefined,
    cpuCores: Math.max(1, cores?.physical ?? cpuList.length),
    cpuThreads,
    gpu,
    totalMemoryBytes,
    freeMemoryBytes,
    budgetBytes,
    budgetBasis: basis,
  };

  logEvent({
    level: "debug",
    source: "app",
    event: "hardware.detect",
    message: `${info.chipName} / ${info.gpu.name}`,
    detail: {
      platform,
      arch,
      gpuKind: info.gpu.kind,
      vramBytes: info.gpu.vramBytes,
      totalMemoryBytes,
      budgetBytes,
      budgetBasis: basis,
    },
  });
  return info;
}

let cached: HardwareInfo | null = null;

/**
 * 机器画像（进程内缓存）。芯片与内存在运行期不会变，引导页的「重新检测」只关心
 * 引擎二进制，不必把 sysctl / system_profiler 再跑一遍。
 */
export function getHardwareInfo(options: { refresh?: boolean } = {}): HardwareInfo {
  if (!options.refresh && cached) return cached;
  cached = detectHardware();
  return cached;
}
