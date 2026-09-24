import { create } from "zustand";

import type { LayaPhase } from "../../bun/systemone-laya";

interface SystemOneInstallState {
  /** JEV 本地运行时（laya-mlx）的安装日志（主进程实时推送，按 80ms 合批）。 */
  logs: string[];
  /** 当前阶段：安装 / 加载权重 / 就绪 / 出错。 */
  phase: LayaPhase;
  phaseMessage: string;
  /** 各权重的下载进度，按 repo 名索引（主进程按权重名合并后推送）。 */
  progress: Record<string, { phase: "downloading" | "done"; bytes: number }>;
  appendLines: (lines: string[]) => void;
  setPhase: (phase: LayaPhase, message: string) => void;
  setProgress: (update: { weights: string; phase: "downloading" | "done"; bytes: number }) => void;
  clearLogs: () => void;
}

const MAX_LOGS = 200;

export const useSystemOneInstallStore = create<SystemOneInstallState>((set) => ({
  logs: [],
  phase: "idle",
  phaseMessage: "",
  progress: {},
  appendLines: (lines) =>
    set((s) => (lines.length === 0 ? s : { logs: [...s.logs, ...lines].slice(-MAX_LOGS) })),
  setPhase: (phase, phaseMessage) => set({ phase, phaseMessage }),
  setProgress: ({ weights, phase, bytes }) =>
    set((s) => ({ progress: { ...s.progress, [weights]: { phase, bytes } } })),
  clearLogs: () => set({ logs: [] }),
}));
