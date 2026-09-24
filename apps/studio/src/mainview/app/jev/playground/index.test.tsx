/**
 * 游乐场的运行回归测试。
 *
 * 盯住一件事：**「开始」必须真的一步步往前走**。
 *
 * 第一版里 `advance` 从 React state 读局面，而「开始」是在一个闭包里连着调它的 ——
 * 整轮循环读到的都是点下按钮那一刻的那一份，于是每一步都基于同一个旧局面：棋子
 * 原地不动、行情永远停在第一根，界面上看起来像"模型每次都选一样的方向"，很难
 * 想到是循环的问题。这种错只有把组件挂起来连跑几步才抓得到。
 */
import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost/" });
const DOM_GLOBALS = [
  "window", "document", "navigator", "location", "history", "localStorage",
  "HTMLElement", "HTMLDivElement", "HTMLButtonElement", "HTMLInputElement", "HTMLTextAreaElement",
  "HTMLSelectElement", "Element", "Node", "Text", "DocumentFragment", "SVGElement", "DOMRect",
  "CustomElementRegistry", "Event", "CustomEvent", "MouseEvent", "PointerEvent", "KeyboardEvent",
  "FocusEvent", "InputEvent", "MutationObserver", "ResizeObserver", "NodeFilter",
  "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle", "matchMedia",
] as const;
const savedGlobals = new Map<string, unknown>();
for (const key of DOM_GLOBALS) {
  const value = (dom as unknown as Record<string, unknown>)[key];
  if (value === undefined) continue;
  savedGlobals.set(key, (globalThis as unknown as Record<string, unknown>)[key]);
  (globalThis as unknown as Record<string, unknown>)[key] = value;
}
(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/** 收到的每一份 state：用来断言"每一步问的是新局面"。 */
const seen: { row: number; col: number }[] = [];
/** 假模型的脾气：会走路，还是像实测里那个弱模型一样一直撞同一堵墙。 */
let mood: "smart" | "always-left" = "smart";

mock.module("@lib/rpc", () => ({
  rpcClient: {
    systemoneStatus: async () => ({ resolved: "cloud", backend: "cloud", cloudConfigured: true, localModels: [], models: [], pricing: { inputPerMTok: 0, outputPerMTok: 0 } }),
    /**
     * 一个会走路的假模型。网格：先往下、再往右 —— 8 步到终点（绕开 (1,2) / (2,3)）；
     * 其余场景：随手挑 criteria 里的第一个选项。各场景共用一个 mock，按问题名分流。
     */
    systemoneRun: async ({ state, questions }: { state: string; questions: Record<string, { type: string; criteria?: Record<string, unknown> }> }) => {
      const answers: Record<string, unknown> = {};
      for (const [name, question] of Object.entries(questions)) {
        if (question.type === "noul") {
          answers[name] = { type: "noul", noul: 0.8 };
          continue;
        }
        if (question.type === "score") {
          // 打分题必须答成 score：答成 choice 的话，`runOnce` 会拿它把同一次调用里
          // 真正的 choice 答案顶掉（它是按 answer.type 分拣的）。
          answers[name] = { type: "score", score: 1, confidence: 0.5, legend: {}, probabilities: { "1": 0.5 } };
          continue;
        }
        const options = Object.keys(question.criteria ?? {});
        let pick = options[0] ?? "";
        if (name === "next_move") {
          const parsed = JSON.parse(state) as { current: { row: number; col: number }; goal: { row: number; col: number } };
          seen.push(parsed.current);
          pick = mood === "always-left" ? "left" : parsed.current.row < parsed.goal.row ? "down" : "right";
        }
        answers[name] = { type: "choice", choice: pick, confidence: 0.9, probabilities: { [pick]: 0.9 } };
      }
      return {
        ok: true,
        response: { model: "jev-latest", answers, usage: { input_tokens: 10, output_tokens: 0 } },
        backend: "cloud",
        requestId: "req_x",
      };
    },
    getSettings: async () => ({ settings: {} }),
    updateSettings: async () => ({ ok: true }),
  },
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { JevPlayground, STEP_PAUSE_MS } = await import("./index");
const { useJevStore } = await import("@stores/jev");
const { translate } = await import("../../../../shared/i18n");

const zh = (key: string) => translate("zh", key);

afterAll(() => {
  for (const [key, value] of savedGlobals) (globalThis as unknown as Record<string, unknown>)[key] = value;
});

async function mountPlayground(): Promise<{ container: HTMLElement; unmount: () => void }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let root: ReturnType<typeof createRoot>;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={client}>
        <JevPlayground />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(label));
  if (!found) throw new Error(`没找到按钮：${label}`);
  return found as HTMLButtonElement;
}

test("「开始」一步步把棋子走到终点（守住「整轮循环都在同一个局面上」那个坑）", async () => {
  seen.length = 0;
  useJevStore.getState().setScenarioId("grid-runner");
  const { container, unmount } = await mountPlayground();
  try {
    await act(async () => {
      button(container, zh("jev.playground.start")).click();
    });
    // 每步之间有一段看得清的停顿（STEP_PAUSE_MS），等它跑满 8 步。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, STEP_PAUSE_MS * 10));
    });

    // 每一步问的都是**新**局面：起点只出现一次，后面的位置各不相同。
    expect(seen.length).toBeGreaterThan(4);
    expect(seen[0]).toEqual({ row: 0, col: 0 });
    expect(seen[1]).not.toEqual(seen[0]);
    const unique = new Set(seen.map((p) => `${p.row},${p.col}`));
    expect(unique.size).toBe(seen.length);

    // 走到终点就该停，并报完成。
    const text = container.textContent ?? "";
    expect(text).toContain(zh("jev.playground.done"));
    // 8 步：down×4 + right×4。
    expect(seen).toHaveLength(8);
  } finally {
    unmount();
    useJevStore.getState().setScenarioId(null);
  }
});

test("「单步」只走一步，棋子换了格子", async () => {
  seen.length = 0;
  useJevStore.getState().setScenarioId("grid-runner");
  const { container, unmount } = await mountPlayground();
  try {
    await act(async () => {
      button(container, zh("jev.playground.step")).click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(seen).toHaveLength(1);
    // 第二次单步问的是走完之后的局面，不是起点。
    await act(async () => {
      button(container, zh("jev.playground.step")).click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual({ row: 1, col: 0 });
  } finally {
    unmount();
    useJevStore.getState().setScenarioId(null);
  }
});

test("行情回放：连着跑会一根根往前走，而不是反复判第一根", async () => {
  useJevStore.getState().setScenarioId("market-replay");
  // 掐一小段（几根日线）—— 这条测试要的是"会不会往前走"，不是跑满一整段区间。
  useJevStore.getState().setMarketSymbol("shc");
  useJevStore.getState().setMarketRange({ from: "2024-01-02", to: "2024-01-10" });
  const { container, unmount } = await mountPlayground();
  try {
    await act(async () => {
      button(container, zh("jev.playground.start")).click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, STEP_PAUSE_MS * 12));
    });
    const text = container.textContent ?? "";
    expect(text).toContain(zh("jev.playground.done"));
  } finally {
    unmount();
    useJevStore.getState().setScenarioId(null);
  }
});

// ---------------------------------------------------------------------------
// 棋盘的运行动画（动画本身是瞬时的，截图抓不到，只能断言图元真的画出来了）
// ---------------------------------------------------------------------------

const { GridView } = await import("./grid-view");
const { newGridRunner, applyMove } = await import("./scenarios");

/** 直接挂一个棋盘（不跑判定），用来看某个局面画出了什么。 */
async function mountGrid(node: React.ReactElement): Promise<{ container: HTMLElement; unmount: () => void }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: ReturnType<typeof createRoot>;
  await act(async () => {
    root = createRoot(container);
    root.render(node);
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

test("路径随每一步接长：折线的点数跟着轨迹走", async () => {
  const start = newGridRunner();
  const one = applyMove(start, "down").next;
  const two = applyMove(one, "right").next;

  const before = await mountGrid(<GridView state={start} trail={[]} lastMove={null} />);
  try {
    // 还没动过：只有起点一个点，不画线（选择器限定在棋盘里 —— 图例里也有一条小折线）。
    expect(before.container.querySelector("svg[role='img'] polyline")).toBeNull();
  } finally {
    before.unmount();
  }

  const after = await mountGrid(
    <GridView state={two} trail={[one.pos, two.pos]} lastMove={{ seq: 2, target: two.pos, moved: true, inBounds: true }} />,
  );
  try {
    const line = after.container.querySelector("svg[role='img'] polyline");
    expect(line).not.toBeNull();
    // 起点 + 两步 = 三个点（格子中心）。
    expect((line?.getAttribute("points") ?? "").trim().split(/\s+/)).toHaveLength(3);
    // 走通的一步不该有撞墙动画。
    expect(after.container.querySelector(".jev-grid-bump")).toBeNull();
    expect(after.container.querySelector(".jev-grid-hit")).toBeNull();
  } finally {
    after.unmount();
  }
});

test("撞墙那一步有反馈：棋子顶一下、被撞的格子亮一圈", async () => {
  // 这条盯的就是"看着像卡住了"：位置不变、步数在涨，界面必须说出"它撞了那一格"。
  const start = newGridRunner();
  const blocked = applyMove(start, "left"); // 起点往左 = 撞边界，位置不变
  expect(blocked.moved).toBe(false);

  const { container, unmount } = await mountGrid(
    <GridView
      state={blocked.next}
      trail={[blocked.next.pos]}
      lastMove={{ seq: 1, target: blocked.target, moved: false, inBounds: blocked.inBounds }}
    />,
  );
  try {
    expect(container.querySelector(".jev-grid-bump")).not.toBeNull();
    // 撞的是盘外（边界），盘面上没有格子可亮 —— 只顶一下。
    expect(container.querySelector(".jev-grid-hit")).toBeNull();
  } finally {
    unmount();
  }

  // 撞盘内的障碍：那一格要亮起来。
  const toWall = applyMove(applyMove(start, "down").next, "right"); // (1,0) → (1,1) 不是障碍
  const atWall = applyMove(toWall.next, "right"); // (1,1) → (1,2) 是障碍
  expect(atWall.moved).toBe(false);
  const hit = await mountGrid(
    <GridView
      state={atWall.next}
      trail={[toWall.next.pos, atWall.next.pos]}
      lastMove={{ seq: 3, target: atWall.target, moved: false, inBounds: atWall.inBounds }}
    />,
  );
  try {
    expect(hit.container.querySelector(".jev-grid-bump")).not.toBeNull();
    expect(hit.container.querySelector(".jev-grid-hit")).not.toBeNull();
  } finally {
    hit.unmount();
  }
});

test("图元是图标不是文字（一格几毫米宽时文字糊成一团）", async () => {
  const { container, unmount } = await mountGrid(<GridView state={newGridRunner()} trail={[]} lastMove={null} />);
  try {
    const board = container.querySelector("svg[role='img']");
    expect(board).not.toBeNull();
    // 盘面里没有裸文字，只有图标与无障碍用的 <title>。
    const texts = [...(board?.querySelectorAll("text") ?? [])];
    expect(texts).toHaveLength(0);
    const titles = [...(board?.querySelectorAll("title") ?? [])].map((node) => node.textContent);
    expect(titles).toContain(zh("jev.playground.grid.markerWall"));
    expect(titles).toContain(zh("jev.playground.grid.markerGoal"));
    expect(titles).toContain(zh("jev.playground.grid.markerHere"));
  } finally {
    unmount();
  }
});

test("模型一直撞墙时界面直说「这个模型没信号」", async () => {
  // 实测过的场景：某个判定模型在这题上 20 步全撞在同一堵墙上，概率四个方向几乎
  // 均分。那时候界面只看得到棋子在原地顶，用户会以为是游乐场坏了 —— 必须说出来。
  mood = "always-left";
  seen.length = 0;
  useJevStore.getState().setScenarioId("grid-runner");
  const { container, unmount } = await mountPlayground();
  try {
    // 断言挑的是那块提示本身，不是文案 —— 测试跑在哪种界面语言下都成立。
    expect(container.querySelector(".jev-note.warn")).toBeNull();
    await act(async () => {
      button(container, zh("jev.playground.start")).click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, STEP_PAUSE_MS * 8));
    });
    // 走了几步全白走 → 提示出现，并把"白走几步 / 共几步"数出来。
    expect(seen.length).toBeGreaterThanOrEqual(4);
    const note = container.querySelector(".jev-note.warn");
    expect(note).not.toBeNull();
    expect(note?.textContent ?? "").toMatch(/\b(\d+)\b/);
  } finally {
    unmount();
    mood = "smart";
    useJevStore.getState().setScenarioId(null);
  }
});
