import { statfsSync } from "node:fs";
import { freemem, loadavg, totalmem } from "node:os";
import { getUserDataDir } from "./paths";
import { getActiveServerPort } from "./db/settings";
import { listInstalledModels } from "./model-store";
import { getGpuStats, type GpuStats } from "./gpu-stats";
import { processVram } from "../shared/gpu-stats";
import type { ServedModelInfo } from "../shared/served-models";

export type ActiveModel = {
  name: string;
  loaded: boolean;
  lastUsedAt: number;
};

/**
 * 一个在跑的实例的资源占用。
 *
 * `vramBytes` 是**实测**：只有 NVIDIA 机器能按 `pid` 把 `nvidia-smi` 的逐进程显存归到
 * 具体实例上；其余情况（Apple 统一内存、非 N 卡、引擎把权重放在子进程里）一律
 * `null`，界面显示「—」而不是猜一个数。`weightsBytes` 是权重文件体积（扫描得到的真数，
 * 哪个平台都有），它回答的是「这个模型本身多大」。
 */
export type ServedInstanceStat = {
  id: string;
  label: string;
  modelRef: string;
  engine: string;
  port: number;
  purpose: string;
  status: string;
  pid: number | null;
  weightsBytes: number | null;
  vramBytes: number | null;
};

export type ServerStats = {
  sessionStartedAt: number;
  serverStartedAt: number;
  prefillTokens: number;
  generationTokens: number;
  requests: number;
  prefillTokensPerSec: number;
  generationTokensPerSec: number;
  activeModels: ActiveModel[];
  /** 在跑的实例（逐模型显存，OPS-05）。 */
  instances: ServedInstanceStat[];
  /** 整卡采样：利用率 / 显存 / 温度 / 功耗（OPS-06）。读不到时带 reason。 */
  gpu: GpuStats;
  system: {
    loadAvg: number[];
    totalMem: number;
    freeMem: number;
    disk: { total: number; free: number };
  };
  modelsSize: number;
};

const sessionStartedAt = Date.now();
let serverStartedAt = 0;
let prefillTokens = 0;
let generationTokens = 0;
let requests = 0;
const recentModels = new Map<string, number>();

/** Called when the local server reports ready so the dashboard can show server uptime. */
export function markServerStarted() {
  serverStartedAt = Date.now();
}

/** Accumulate token usage from every inference call (chat + OCR). */
export function recordUsage(modelId: string, promptTokens: number, completionTokens: number) {
  if (promptTokens > 0) prefillTokens += promptTokens;
  if (completionTokens > 0) generationTokens += completionTokens;
  requests += 1;
  if (modelId) recentModels.set(modelId, Date.now());
}

/** Query llama-server /slots for the models actually loaded in VRAM/RAM. */
async function fetchLoadedModels(): Promise<string[]> {
  try {
    const port = getActiveServerPort();
    const res = await fetch(`http://localhost:${port}/slots`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as Array<{ model?: string }>;
    const names = new Set<string>();
    for (const slot of data) {
      if (slot?.model) names.add(slot.model);
    }
    return [...names];
  } catch {
    return [];
  }
}

/**
 * 在跑的实例 → 资源占用。
 *
 * 实例清单由调用方传进来（RPC 层已有 `listServedModels()`）：`stats.ts` 不反向 import
 * `model-servers.ts`，否则会绕出一条 stats → model-servers → runtimes → stats 的循环。
 */
export function servedInstanceStats(
  served: ServedModelInfo[],
  vramByPid: Map<number, number>,
): ServedInstanceStat[] {
  return served
    .filter((m) => m.status !== "stopped")
    .map((m) => ({
      id: m.id,
      label: m.label,
      modelRef: m.modelRef,
      engine: m.engine,
      port: m.port,
      purpose: m.purpose,
      status: m.status,
      pid: m.pid ?? null,
      weightsBytes: m.sizeBytes ?? null,
      vramBytes: m.pid !== undefined ? vramByPid.get(m.pid) ?? null : null,
    }));
}

export async function getServerStats(served: ServedModelInfo[] = []): Promise<ServerStats> {
  const loaded = await fetchLoadedModels();
  const loadedSet = new Set(loaded);

  const active: ActiveModel[] = [];
  for (const [name, lastUsedAt] of recentModels) {
    // If /slots is unavailable, treat recently used models as loaded.
    active.push({ name, loaded: loaded.length === 0 || loadedSet.has(name), lastUsedAt });
  }
  active.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  for (const name of loaded) {
    if (!active.some((m) => m.name === name)) {
      active.push({ name, loaded: true, lastUsedAt: 0 });
    }
  }

  const gpu = await getGpuStats();
  const vramByPid = gpu.available ? processVram(gpu.processes) : new Map<number, number>();

  const elapsed = Math.max((Date.now() - sessionStartedAt) / 1000, 1);
  const modelsSize = listInstalledModels().reduce((sum, m) => sum + (m.size || 0), 0);

  // Free/total bytes of the filesystem hosting the app data dir (where models live).
  let disk = { total: 0, free: 0 };
  try {
    const fs = statfsSync(getUserDataDir());
    disk = { total: fs.blocks * fs.bsize, free: fs.bavail * fs.bsize };
  } catch {
    // statfs unsupported — leave zeros, UI shows "—"
  }

  return {
    sessionStartedAt,
    serverStartedAt,
    prefillTokens,
    generationTokens,
    requests,
    prefillTokensPerSec: prefillTokens / elapsed,
    generationTokensPerSec: generationTokens / elapsed,
    activeModels: active,
    instances: servedInstanceStats(served, vramByPid),
    gpu,
    system: {
      loadAvg: loadavg(),
      totalMem: totalmem(),
      freeMem: freemem(),
      disk,
    },
    modelsSize,
  };
}
