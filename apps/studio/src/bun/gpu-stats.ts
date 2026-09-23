/**
 * GPU 采样（整卡利用率 / 显存 / 温度 / 功耗）与逐进程显存归属。
 *
 * 为什么单独一个模块而不是塞进 `bun/hardware.ts`：那边答的是「这台机器是什么」
 * （芯片 / 内存 / 显存总量），探测一次就永久缓存；这里答的是「此刻在发生什么」，
 * 数值每秒都在变，服务统计页每 2 秒问一次 —— 缓存策略、超时、失败处理都不一样。
 *
 * 两条实现细节值得写下来：
 *  - **走异步 `Bun.spawn`，不用 `defaultCommandRunner` 的 `spawnSync`**：那一个是给
 *    引导页那种「跑一次、之后一直用缓存」的场景准备的。nvidia-smi 冷启动要几百毫秒
 *    到一秒多，同步跑会把这期间的所有 RPC 一起卡住（服务统计页每 2 秒问一次，等于
 *    每秒都在主进程里堵一下）。ENOENT 仍按同一个约定折成 `code: -1`。
 *  - **读不到就如实说读不到**：Apple 芯片是统一内存、非 N 卡的 Mac 没有 nvidia-smi、
 *    Linux 上没装 N 卡驱动同样没有 —— 这些都在 `reason` 里分开，界面显示「—」并给出
 *    原因，绝不猜一个数（那会让用户按错的数字去调参数）。
 */
import { logEvent } from "./app-log";
import { getHardwareInfo } from "./hardware";
import type { GpuKind } from "../shared/hardware";
import {
  gpuStatsUnavailableReason,
  parseNvidiaSmiProcesses,
  parseNvidiaSmiSamples,
  type GpuProcessUsage,
  type GpuStats,
} from "../shared/gpu-stats";

export type { GpuStats } from "../shared/gpu-stats";

export type GpuCommandResult = { code: number; stdout: string; stderr: string };
/** 与 `command-runner` 的 `CommandRunner` 同形，但 `run` 是异步的（见文件头说明）。 */
export type GpuCommandRunner = { run: (cmd: string[]) => Promise<GpuCommandResult> };

/** 采样超时：超过这个时间就杀掉，宁可这一轮没有数字也不拖住界面。 */
const PROBE_TIMEOUT_MS = 1_500;
/** 缓存时长：与服务统计页的 2 秒轮询同量级 —— 同一轮里多个调用方只跑一次命令。 */
const CACHE_TTL_MS = 2_000;

const GPU_QUERY = [
  "nvidia-smi",
  "--query-gpu=index,name,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw",
  "--format=csv,noheader,nounits",
];
const PROCESS_QUERY = [
  "nvidia-smi",
  "--query-compute-apps=pid,process_name,used_memory",
  "--format=csv,noheader,nounits",
];

const defaultRunner: GpuCommandRunner = {
  run: async (cmd) => {
    try {
      const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // 已经退出了
        }
      }, PROBE_TIMEOUT_MS);
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { code: code ?? -1, stdout, stderr };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      // 命令不存在时 Bun.spawn 是抛异常（与 command-runner 同一个坑），折成 -1。
      return { code: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
    }
  },
};

function isMissingCommand(stderr: string): boolean {
  return /not found|no such file|enoent/i.test(stderr);
}

export type DetectGpuStatsOptions = {
  runner?: GpuCommandRunner;
  platform?: string;
  gpuKind?: GpuKind;
};

/**
 * 跑一次采样。读不到就返回 `{ available: false, reason }` —— 调用方按 reason 出文案。
 */
export async function detectGpuStats(options: DetectGpuStatsOptions = {}): Promise<GpuStats> {
  const platform = options.platform ?? process.platform;
  const gpuKind = options.gpuKind ?? getHardwareInfo().gpu.kind;

  // Apple 芯片与其它 Mac：nvidia-smi 不适用，连命令都不跑。
  if (gpuKind === "apple" || platform === "darwin") {
    return {
      available: false,
      reason: gpuStatsUnavailableReason({ platform, gpuKind, commandMissing: false }),
    };
  }

  const runner = options.runner ?? defaultRunner;
  const gpuRes = await runner.run(GPU_QUERY);
  if (gpuRes.code !== 0) {
    const commandMissing = isMissingCommand(gpuRes.stderr);
    // 命令不存在是常态（纯 CPU 机器 / 没装驱动），只有「命令在却答不出来」才值得记日志。
    if (!commandMissing && gpuRes.stderr.trim()) {
      logEvent({
        level: "warn",
        source: "app",
        event: "hardware.gpu.stats_probe_failed",
        message: "nvidia-smi 采样失败，服务统计页不显示显卡数据",
        detail: { code: gpuRes.code, stderr: gpuRes.stderr.trim().slice(0, 500) },
      });
    }
    return {
      available: false,
      reason: gpuStatsUnavailableReason({ platform, gpuKind, commandMissing }),
    };
  }

  const gpus = parseNvidiaSmiSamples(gpuRes.stdout);
  if (gpus.length === 0) {
    logEvent({
      level: "warn",
      source: "app",
      event: "hardware.gpu.stats_empty",
      message: "nvidia-smi 没有返回任何显卡，按「读不到」处理（不给 0 张卡的假成功）",
      detail: { stdout: gpuRes.stdout.trim().slice(0, 500) },
    });
    return { available: false, reason: "probe-failed" };
  }

  // 逐进程归属是加分项：这条命令拿不到也不影响整卡数据。
  let processes: GpuProcessUsage[] = [];
  const procRes = await runner.run(PROCESS_QUERY);
  if (procRes.code === 0) processes = parseNvidiaSmiProcesses(procRes.stdout);

  return { available: true, gpus, processes };
}

let cached: { at: number; value: GpuStats } | null = null;
let inFlight: Promise<GpuStats> | null = null;

/**
 * 带缓存的采样（默认路径）。缓存与去重都只在「生产探测」时生效：测试注入 runner /
 * platform / gpuKind 时不读也不写缓存，避免用例之间互相污染。
 */
export async function getGpuStats(
  options: DetectGpuStatsOptions & { refresh?: boolean; now?: number } = {},
): Promise<GpuStats> {
  const injectable = options.runner !== undefined || options.platform !== undefined || options.gpuKind !== undefined;
  const now = options.now ?? Date.now();
  if (injectable) return detectGpuStats(options);

  if (!options.refresh) {
    if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;
    if (inFlight) return inFlight;
  }
  const probe = detectGpuStats()
    .then((value) => {
      cached = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      inFlight = null;
    });
  inFlight = probe;
  return probe;
}
