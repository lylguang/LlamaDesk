/**
 * GPU 采样（利用率 / 显存 / 温度 / 功耗）与「哪个进程占了多少显存」的解析。
 *
 * 探测动作在 `bun/gpu-stats.ts`（nvidia-smi），这里只放纯解析与「为什么拿不到」的判定：
 * 解析函数留在共享层，是为了能拿真机输出钉住格式（nvidia-smi 的 CSV 字段里，名字可能
 * 带逗号、数值可能是 `[N/A]` / `[Not Supported]`），判定函数留在共享层，是为了让界面
 * 的文案与主进程的结论出自同一处。
 *
 * 实测与估算分开：能读到就给真数，读不到就是 `null` —— 界面显示「—」，**不猜一个数**。
 * Apple 芯片是统一内存（GPU 与 CPU 共用物理内存），没有「显存」这个量，这是设计事实
 * 而不是探测失败，所以单独一档 reason。
 */
import type { GpuKind } from "./hardware";

/** 一张卡的瞬时采样。读不到的字段是 null（驱动可能不支持功耗、虚拟机可能不暴露温度）。 */
export type GpuSample = {
  index: number;
  name: string;
  memoryTotalBytes: number | null;
  memoryUsedBytes: number | null;
  /** 利用率（0-100）。 */
  utilizationPct: number | null;
  temperatureC: number | null;
  powerWatts: number | null;
};

/** 某个进程在这张卡上占用的显存。 */
export type GpuProcessUsage = {
  pid: number;
  name: string;
  usedBytes: number;
};

export type GpuStatsUnavailableReason =
  /** Apple 芯片：统一内存，没有独立的「显存」可读。 */
  | "unified-memory"
  /** 非 Apple 的 Mac（AMD / Intel 独显）：nvidia-smi 不适用。 */
  | "non-nvidia"
  /** 机器上没有 nvidia-smi（没装 NVIDIA 驱动或没有 N 卡）。 */
  | "no-tool"
  /** 命令在，但这次没答上来（输出异常 / 超时）。 */
  | "probe-failed";

export type GpuStats =
  | { available: true; gpus: GpuSample[]; processes: GpuProcessUsage[] }
  | { available: false; reason: GpuStatsUnavailableReason };

/**
 * nvidia-smi 的 CSV 一行拆成字段。
 *
 * 分隔是「逗号 + 空格」，但**字段本身可能带逗号**（`NVIDIA RTX A4000, 16GB` 这类名字），
 * 那种字段会被双引号包住 —— 所以不能直接 `split(",")`（那会把卡名切成两段，后面的
 * 显存、温度全部错位）。引号占位但不进结果，逗号在引号内不算分隔。
 */
export function splitNvidiaSmiFields(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (ch === "," && !quoted) {
      fields.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  fields.push(current.trim());
  return fields;
}

/** `1024` / `55.5` / `[N/A]` / `[Not Supported]` → number | null。 */
function smiNumber(text: string | undefined): number | null {
  if (!text) return null;
  const match = /-?\d+(?:\.\d+)?/.exec(text);
  if (!match) return null;
  const value = Number.parseFloat(match[0]);
  return Number.isFinite(value) ? value : null;
}

/** MiB → bytes（nvidia-smi 用 `--format=nounits` 时显存一律是 MiB）。 */
function mibToBytes(mib: number | null): number | null {
  return mib === null ? null : Math.round(mib * 1024 * 1024);
}

/**
 * `nvidia-smi --query-gpu=index,name,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw --format=csv,noheader,nounits`
 * 的输出，一行一张卡：
 *
 * ```
 * 0, NVIDIA GeForce RTX 4090, 24564, 1024, 37, 55, 120.45
 * 1, "NVIDIA RTX A4000, 16GB", 16376, [N/A], [N/A], [N/A], [N/A]
 * ```
 *
 * 认不出的行直接跳过（残留提示文字、空行），一张卡都没有时返回空数组 ——
 * 调用方据此转成 `probe-failed`，而不是给出 0 张卡的「成功」。
 */
export function parseNvidiaSmiSamples(stdout: string): GpuSample[] {
  const samples: GpuSample[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const fields = splitNvidiaSmiFields(line);
    const index = smiNumber(fields[0]);
    const name = fields[1];
    if (index === null || !name) continue;
    samples.push({
      index,
      name,
      memoryTotalBytes: mibToBytes(smiNumber(fields[2])),
      memoryUsedBytes: mibToBytes(smiNumber(fields[3])),
      utilizationPct: smiNumber(fields[4]),
      temperatureC: smiNumber(fields[5]),
      powerWatts: smiNumber(fields[6]),
    });
  }
  return samples;
}

/**
 * `nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits`
 * 的输出：
 *
 * ```
 * 4711, /opt/homebrew/bin/llama-server, 5120
 * 4712, "python3 -m vllm, worker", 20480
 * ```
 *
 * 进程名同样可能带逗号，所以**取首字段当 pid、末字段当显存**，中间的都算名字：
 * 按位置硬取第三列会把带逗号的名字读成显存。
 */
export function parseNvidiaSmiProcesses(stdout: string): GpuProcessUsage[] {
  const usages: GpuProcessUsage[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const fields = splitNvidiaSmiFields(line);
    if (fields.length < 2) continue;
    const pid = smiNumber(fields[0]);
    const used = mibToBytes(smiNumber(fields[fields.length - 1]));
    if (pid === null || used === null) continue;
    const name = fields.length > 2 ? fields.slice(1, -1).join(", ") : fields[1]!;
    usages.push({ pid: Math.round(pid), name, usedBytes: used });
  }
  return usages;
}

/** 进程占用的显存按 pid 汇总（同一 pid 出现多次时相加，不覆盖）。 */
export function processVram(processes: GpuProcessUsage[]): Map<number, number> {
  const totals = new Map<number, number>();
  for (const proc of processes) {
    totals.set(proc.pid, (totals.get(proc.pid) ?? 0) + proc.usedBytes);
  }
  return totals;
}

/**
 * 读不到时到底是哪一种读不到 —— 文案与结论出自同一处，界面不再各自猜。
 *
 * 顺序有意：Apple 芯片先判（它的「没有显存」是设计事实，跟有没有 nvidia-smi 无关），
 * 再判非 N 卡的 Mac，最后才落到「命令缺失 / 这次失败」。
 */
export function gpuStatsUnavailableReason(input: {
  platform: string;
  gpuKind: GpuKind;
  commandMissing: boolean;
}): GpuStatsUnavailableReason {
  if (input.gpuKind === "apple") return "unified-memory";
  if (input.platform === "darwin") return "non-nvidia";
  return input.commandMissing ? "no-tool" : "probe-failed";
}
