/**
 * JEV 每次判定的耗时（侧栏「数据驾驶舱」读它）。
 *
 * 为什么单独开一个 store 而不是查账本：`usage` 记的是次数与 tokens，没有延迟；
 * 而"这个后端快不快"恰恰是选本地还是选云端时最先想知道的事。三条发起判定的路径
 * （判定台运行、游乐场每一步、引擎面板的测试连接）都往这里记一笔，所以侧栏看到的
 * 是**这台机器刚刚真的跑出来的**数字，不是某个后端的标称值。
 *
 * 只留最近 50 次：驾驶舱看的是"现在这套配置的手感"，更久以前的样本换过模型、
 * 换过网络，混在一起平均出来的数反而骗人。
 */
import { create } from "zustand";

export type JevSample = {
  at: number;
  /** 端到端耗时（毫秒）：从发请求到拿到答案，包含网络。 */
  ms: number;
  ok: boolean;
  /** 实际走的后端（cloud / local-url / local-runtime），失败时可能为 null。 */
  backend: string | null;
  /** 触发这次判定的地方，驾驶舱不显示，排查时有用。 */
  source: "console" | "playground" | "test";
};

const MAX_SAMPLES = 50;

type JevMetricsState = {
  samples: JevSample[];
  record: (sample: JevSample) => void;
  clear: () => void;
};

export const useJevMetrics = create<JevMetricsState>((set) => ({
  samples: [],
  record: (sample) => set((prev) => ({ samples: [...prev.samples, sample].slice(-MAX_SAMPLES) })),
  clear: () => set({ samples: [] }),
}));

export type JevMetricsSummary = {
  count: number;
  failed: number;
  /** 最近一次的耗时；没有样本时为 null。 */
  last: number | null;
  average: number | null;
  /** 第 95 百分位：偶发的那几次慢请求就藏在这儿，平均值看不出来。 */
  p95: number | null;
  fastest: number | null;
  slowest: number | null;
};

/** 统计只看成功的样本：失败的那次往往是 0 ms 或超时，混进来会把平均拉得没意义。 */
export function summarize(samples: readonly JevSample[]): JevMetricsSummary {
  const ok = samples.filter((s) => s.ok);
  const failed = samples.length - ok.length;
  if (ok.length === 0) {
    return { count: samples.length, failed, last: null, average: null, p95: null, fastest: null, slowest: null };
  }
  const sorted = [...ok].map((s) => s.ms).sort((a, b) => a - b);
  const sum = sorted.reduce((acc, ms) => acc + ms, 0);
  // 样本少的时候 p95 就是最慢的那次 —— 不插值，免得给出一个谁都没跑出来过的数。
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return {
    count: samples.length,
    failed,
    last: ok[ok.length - 1]?.ms ?? null,
    average: Math.round(sum / sorted.length),
    p95: sorted[Math.max(0, index)] ?? null,
    fastest: sorted[0] ?? null,
    slowest: sorted[sorted.length - 1] ?? null,
  };
}
