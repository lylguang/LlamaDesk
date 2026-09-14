// 只作类型用：webview 不能值导入 bun/*（主进程模块会带上 os / fs，整页白屏）。
import type { UpdateInfo } from "@/bun/updates";
import { create } from "zustand";

type UpdateStore = {
  updateState: UpdateInfo;
  setUpdateState: (updateState: UpdateInfo) => void;
};

export const useUpdateStore = create<UpdateStore>((set) => ({
  updateState: {
    status: "checking",
    currentVersion: "0.0.0",
  },
  setUpdateState: (updateState) => set({ updateState }),
}));
