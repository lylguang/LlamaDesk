/**
 * JEV 页的会话状态（一个 store，页面与侧栏共用）。
 *
 * 为什么要有 store 而不是 useState：示例清单在**侧栏**、编辑器在**主区**，
 * 点侧栏那一下要改主区里正在编辑的草稿。两处隔着 `MainLayout` 的层级，
 * 用 store 比一路传回调清楚，也顺带让"切走再回来"不丢当前草稿。
 */
import { create } from "zustand";

import { useUILang } from "@stores/ui-lang";
import { buildQuestions, type QuestionDraft } from "../app/jev/drafts";
import { jevExamples } from "../app/jev/examples";
import {
  clampBreakoutEvery,
  clampGridSize,
  clampWallCount,
  BREAKOUT_EVERY_DEFAULT,
  GRID_SIZE,
  GRID_WALLS,
} from "../app/jev/playground/scenarios";
import { defaultMarketRange, marketSpan, type MarketSymbol } from "../app/jev/playground/market-data";

/** 左栏顶部那个切换：本地运行 / 云端接入（与语音合成页的"推理引擎"同一处位置）。 */
export type JevEngineTab = "local" | "cloud";

type JevState = {
  engineTab: JevEngineTab;
  setEngineTab: (tab: JevEngineTab) => void;
  state: string;
  setState: (value: string) => void;
  drafts: QuestionDraft[];
  setDrafts: (next: QuestionDraft[]) => void;
  model: string;
  setModel: (value: string) => void;
  /** 当前装载的示例 id（侧栏高亮用）；手改过就不算示例了。 */
  exampleId: string | null;
  applyExample: (id: string) => void;
  /**
   * 侧栏顶部的两段切换：判定台（现有编辑器）/ 游乐场（自动跑一串判定）。
   * 放 store 而不是 useState：切换入口在侧栏，主体在另一层组件里。
   */
  view: "console" | "playground";
  setView: (view: "console" | "playground") => void;
  /** 游乐场当前选中的场景 id（侧栏高亮用）；还没点过任何场景时是 null。 */
  scenarioId: string | null;
  setScenarioId: (id: string | null) => void;
  /**
   * 网格寻路的盘面设置：边长与障碍数量。放 store 而不是组件 state —— 改了要整局
   * 重开（`index.tsx` 拿它当重置的依赖），留在组件里会被"换场景再换回来"抹掉。
   */
  gridSize: number;
  gridWalls: number;
  setGridSize: (size: number) => void;
  setGridWalls: (count: number) => void;
  /**
   * 行情回放的设置：标的、区间两端（`YYYY-MM-DD`）、以及用户写的策略。
   * 和盘面设置同理 —— 改任何一项都要整局重开，所以必须活得比组件久。
   */
  marketSymbol: MarketSymbol;
  marketFrom: string;
  marketTo: string;
  marketStrategy: string;
  setMarketSymbol: (symbol: MarketSymbol) => void;
  setMarketRange: (range: { from?: string; to?: string }) => void;
  setMarketStrategy: (strategy: string) => void;
  /** 打砖块：每隔几帧判定一次（唯一可调的参数，也是这个场景真正的变量）。 */
  breakoutEvery: number;
  setBreakoutEvery: (every: number) => void;
  /** AI 生成的草稿填进来（同样是一次性内容，不算某个示例）。 */
  applyDraft: (payload: { state: string; drafts: QuestionDraft[] }) => void;
  reset: () => void;
};

/**
 * 打开页面时装哪一份内容：**当前语言的第一个示例**（工单分派）。
 *
 * 以前这里写死了一份英文默认值，结果是中文界面打开先看到一段英文工单 —— 用户第一次
 * 进这一页，看到的东西就应该是中文的、且点一下「运行」就能出结果（"可以让它演示"）。
 */
function initialContent(lang: string): { exampleId: string; state: string; drafts: QuestionDraft[] } {
  const first = jevExamples(lang)[0];
  if (!first) return { exampleId: "", state: "", drafts: [] };
  return { exampleId: first.id, state: first.state, drafts: cloneDrafts(first.questions) };
}

/** 深拷贝示例草稿：示例是模块级常量，用户改了草稿不能把常量改掉。 */
function cloneDrafts(drafts: QuestionDraft[]): QuestionDraft[] {
  return drafts.map((draft) => ({
    ...draft,
    id: `${draft.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    options: draft.options.map((option) => ({ ...option })),
    levels: [...draft.levels],
  }));
}

export const useJevStore = create<JevState>((set) => ({
  engineTab: "local",
  setEngineTab: (engineTab) => set({ engineTab }),
  ...initialContent(useUILang.getState().lang),
  setState: (state) => set({ state }),
  // 手改草稿之后不再算"某个示例"——否则侧栏会一直高亮着一个已经不成立的例子。
  setDrafts: (drafts) => set({ drafts, exampleId: null }),
  model: "",
  setModel: (model) => set({ model }),
  applyExample: (id) => {
    const example = jevExamples(useUILang.getState().lang).find((item) => item.id === id);
    if (!example) return;
    set({ exampleId: id, state: example.state, drafts: cloneDrafts(example.questions), model: "" });
  },
  applyDraft: ({ state, drafts }) => set({ exampleId: null, state, drafts }),
  // 重置 = 回到"刚打开这一页"的样子（当前语言的第一个示例），而不是回到空白。
  reset: () => set({ ...initialContent(useUILang.getState().lang), model: "" }),
  view: "console",
  setView: (view) => set({ view }),
  scenarioId: null,
  setScenarioId: (scenarioId) => set({ scenarioId }),
  gridSize: GRID_SIZE,
  gridWalls: GRID_WALLS.length,
  // 边长变了，障碍数量要跟着夹回新盘面的上限：10×10 摆着 25 个障碍，缩回 4×4
  // 就只剩 4 个位置，不夹的话生成器会一直试到放不下，用户看到的是"数字没变但障碍变少了"。
  setGridSize: (size) =>
    set((prev) => {
      const gridSize = clampGridSize(size);
      return { gridSize, gridWalls: clampWallCount(gridSize, prev.gridWalls) };
    }),
  setGridWalls: (count) => set((prev) => ({ gridWalls: clampWallCount(prev.gridSize, count) })),
  marketSymbol: "shc",
  marketFrom: defaultMarketRange("shc").from,
  marketTo: defaultMarketRange("shc").to,
  marketStrategy: "",
  // 换标的不动区间：三份行情覆盖的日期基本一致，用户刚挑好的区间不该被换个指数抹掉。
  // 只把两端夹回新行情的覆盖范围，免得选到一个空窗口。
  setMarketSymbol: (marketSymbol) =>
    set((prev) => {
      const span = marketSpan(marketSymbol);
      const clamp = (date: string) => (date < span.first ? span.first : date > span.last ? span.last : date);
      return { marketSymbol, marketFrom: clamp(prev.marketFrom), marketTo: clamp(prev.marketTo) };
    }),
  setMarketRange: ({ from, to }) =>
    set((prev) => ({ marketFrom: from ?? prev.marketFrom, marketTo: to ?? prev.marketTo })),
  setMarketStrategy: (marketStrategy) => set({ marketStrategy }),
  breakoutEvery: BREAKOUT_EVERY_DEFAULT,
  setBreakoutEvery: (every) => set({ breakoutEvery: clampBreakoutEvery(every) }),
}));


/** 当前请求体（问题名 → 官方问题对象），供运行与"复制示例"共用。 */
export function currentQuestions(drafts: QuestionDraft[]) {
  return buildQuestions(drafts);
}
