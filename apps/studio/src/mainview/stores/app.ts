import { create } from "zustand";

// AppId（每条一级菜单的 id）与菜单顺序 / 显隐一起定义在 shared/app-rail.ts：
// 菜单本体与设置 → 外观 的配置卡共用同一份清单，避免"配得到但看不到"。
import type { AppId } from "../../shared/app-rail";

export type { AppId };

type AppState = {
  activeApp: AppId;
  setActiveApp: (app: AppId) => void;
};

export const useAppStore = create<AppState>((set) => ({
  activeApp: "chat",
  setActiveApp: (activeApp) => set({ activeApp }),
}));
