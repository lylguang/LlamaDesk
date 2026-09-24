/**
 * 把「机器画像」（bun/hardware.ts）+ 「此刻的显存采样」（bun/gpu-stats.ts）组装成
 * 规划器（shared/launch-planner.ts 的 `PlannerHardware`）能吃的硬件快照。
 *
 * 两个来源的口径不一样，这里是唯一的合流点：
 *   - `GpuInfo.vramBytes` 是**总量**（nvidia-smi / sysfs 里读死的），不是空闲；
 *   - 空闲显存只有 gpu-stats 有（它跑 `nvidia-smi --query-gpu=…memory.total,memory.used…`），
 *     `free = total - used`。
 * 所以「读不到空闲」时绝不拿总量冒充空闲：`vramFreeBytes` 给 null，让规划器
 * （`resolveBudgetBytes`）自己退到系统内存口径 —— 那是设计内的降级，不是本层的补丁。
 */
import { getGpuStats, type DetectGpuStatsOptions, type GpuStats } from "./gpu-stats";
import { getHardwareInfo } from "./hardware";
import type { PlannerHardware } from "../shared/launch-planner";

/** 与 `DetectGpuStatsOptions` 同形但全部可选：`detectGpuStats` 的签名默认值 = `{}`，
 *  undefined 与不传等价（测试注入 runner / platform / gpuKind）。 */
export type PlannerGpuStatsOptions = {
  runner?: DetectGpuStatsOptions["runner"];
  platform?: DetectGpuStatsOptions["platform"];
  gpuKind?: DetectGpuStatsOptions["gpuKind"];
};

export type PlannerHardwareSnapshotOptions = {
  /** 透传给 `getHardwareInfo`：芯片 / 内存在运行期不变，默认走进程内缓存。 */
  refresh?: boolean;
  /** 注入 gpu-stats（测试用）。不传时走 `getGpuStats` 的默认路径（2s 缓存 + 去重）。 */
  gpuStats?: PlannerGpuStatsOptions;
};

/**
 * 取显存最大的那张卡的 total/used（规划器目前是单卡模型，多卡先只用最大的那张，
 * 不做逐卡预算——这是有意的简化，多卡按层切分是后续工作）。
 */
function largestCard(stats: GpuStats): {
  total: number;
  free: number;
} | null {
  if (!stats.available || stats.gpus.length === 0) return null;
  let best: { total: number; free: number } | null = null;
  for (const g of stats.gpus) {
    if (g.memoryTotalBytes == null || g.memoryUsedBytes == null) continue;
    const total = g.memoryTotalBytes;
    const free = Math.max(0, total - g.memoryUsedBytes);
    if (best === null || total > best.total) best = { total, free };
  }
  return best;
}

export async function plannerHardwareSnapshot(
  opts?: PlannerHardwareSnapshotOptions,
): Promise<PlannerHardware> {
  const hw = await getHardwareInfo({ refresh: opts?.refresh });
  const gpu = hw.gpu;
  const unifiedMemory = gpu.unifiedMemory === true;
  const hasGpu = gpu.kind !== "none" && gpu.kind !== "unknown";

  let vramTotalBytes: number | null = null;
  let vramFreeBytes: number | null = null;

  if (unifiedMemory) {
    // 统一内存（Apple Silicon / AMD APU）：内存即显存，不做独立显存预算。
    vramTotalBytes = null;
    vramFreeBytes = null;
  } else if (gpu.kind === "nvidia") {
    // 空闲只认 gpu-stats：拿不到（超时 / 无 nvidia-smi / 空输出）就不猜，
    // free 给 null，规划器退到系统内存口径。
    const stats = await getGpuStats(opts?.gpuStats ?? {});
    const card = largestCard(stats);
    if (card !== null) {
      vramTotalBytes = card.total;
      vramFreeBytes = card.free;
    } else {
      // 总量从机器画像拿（nvidia-smi 的 memory.total），空闲仍未知。
      vramTotalBytes = gpu.vramBytes ?? null;
      vramFreeBytes = null;
    }
  } else {
    // AMD 独显 / Intel / 其它：总量有、空闲读不到（没有逐卡采样通道）。
    vramTotalBytes = gpu.vramBytes ?? null;
    vramFreeBytes = null;
  }

  return {
    hasGpu,
    vramFreeBytes,
    vramTotalBytes,
    systemFreeBytes: hw.freeMemoryBytes,
    systemTotalBytes: hw.totalMemoryBytes,
    unifiedMemory,
    cpuThreads: hw.cpuThreads,
  };
}
