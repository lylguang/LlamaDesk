/**
 * 游乐场场景的纯逻辑测试（`scenarios.ts`）。
 *
 * 守的是三件"错了很难从界面上看出来"的事：
 * 1. 网格移动的合法性判定与计步规则（撞墙 / 出界不移动但计步，到达终点即停）；
 * 2. 发给模型的 `state` / `questions` 必须是**官方协议能过的形状**（`validateSystemOneRequest`
 *    直接验）且字段完整 —— 游乐场是要自动连跑十几次的，一次 422 会让整条轨迹中断；
 * 3. 成绩统计的算法（行情回放的净值 / 基准、打砖块的计分），边界值不能变成 NaN。
 */
import { describe, expect, test } from "bun:test";

import { validateSystemOneRequest } from "../../../../shared/systemone";
import type {
  SystemOneChoiceQuestion,
  SystemOneScoreQuestion,
} from "../../../../shared/systemone";
import {
  applyMove,
  gridRunnerQuestions,
  gridRunnerState,
  buildGridWalls,
  clampGridSize,
  clampWallCount,
  gridMaxSteps,
  GRID_SIZE_MAX,
  GRID_SIZE_MIN,
  maxWallsFor,
  newGridRunner,
  PLAYGROUND_SCENARIOS,
  type GridDirection,
  applyMarketDecision,
  marketActionQuestion,
  marketIndicators,
  marketReplayQuestions,
  marketReplayState,
  marketStats,
  marketSteps,
  newMarketReplay,
  MARKET_ACTIONS,
  MARKET_FEE,
  MARKET_RISK_LEVELS,
  applyBreakoutAction,
  breakoutQuestions,
  breakoutState,
  breakoutStats,
  bricksLeft,
  clampBreakoutEvery,
  newBreakout,
  isBreakoutCoinFlip,
  paddleAtLeftWall,
  paddleAtRightWall,
  paddleCenter,
  predictLanding,
  breakoutVisionQuestions,
  breakoutVisionState,
  BREAKOUT_ACTIONS,
  BREAKOUT_BALL_R,
  BREAKOUT_COLS,
  BREAKOUT_EVERY_MAX,
  BREAKOUT_EVERY_MIN,
  BREAKOUT_H,
  BREAKOUT_LIVES,
  BREAKOUT_MAX_DECISIONS,
  BREAKOUT_PADDLE_W,
  BREAKOUT_ROWS,
  BREAKOUT_W,
  type BreakoutAction,
  type BreakoutFrame,
  type BreakoutState,
} from "./scenarios";
import {
  clampMarketWindow,
  defaultMarketRange,
  marketBars,
  marketSpan,
  MARKET_MAX_BARS,
  MARKET_SYMBOLS,
  type MarketBar,
} from "./market-data";

// ---------------------------------------------------------------------------
// 场景 A：grid-runner
// ---------------------------------------------------------------------------

describe("grid-runner：移动与计步", () => {
  test("开局：起点 (0,0)、步数 0、未结束", () => {
    const start = newGridRunner();
    expect(start.pos).toEqual([0, 0]);
    expect(start.goal).toEqual([4, 4]);
    expect(start.size).toBe(5);
    expect(start.steps).toBe(0);
    expect(start.atGoal).toBe(false);
    expect(start.over).toBe(false);
    // 两个障碍都在界内且不等于起点 / 终点。
    for (const [row, col] of start.walls) {
      expect(row).toBeGreaterThanOrEqual(0);
      expect(row).toBeLessThan(5);
      expect(col).toBeGreaterThanOrEqual(0);
      expect(col).toBeLessThan(5);
      expect([row, col]).not.toEqual([0, 0]);
      expect([row, col]).not.toEqual([4, 4]);
    }
  });

  test("合法移动：位置更新、步数 +1", () => {
    const start = newGridRunner();
    const move = applyMove(start, "right");
    expect(move.moved).toBe(true);
    expect(move.inBounds).toBe(true);
    expect(move.hitsWall).toBe(false);
    expect(move.next.pos).toEqual([0, 1]);
    expect(move.next.steps).toBe(1);
    expect(move.next.over).toBe(false);
  });

  test("纯函数：原局面不被修改", () => {
    const start = newGridRunner();
    const before = JSON.stringify(start);
    applyMove(start, "right");
    expect(JSON.stringify(start)).toBe(before);
  });

  test("非法移动（出界）：位置不变但计步", () => {
    const start = newGridRunner();
    const move = applyMove(start, "up"); // 第 0 行再往上 = 出界
    expect(move.moved).toBe(false);
    expect(move.inBounds).toBe(false);
    expect(move.hitsWall).toBe(false);
    expect(move.next.pos).toEqual([0, 0]);
    expect(move.next.steps).toBe(1);
  });

  test("非法移动（撞障碍）：位置不变但计步", () => {
    // (1,0) → right → (1,1)：再 right 就会撞到固定障碍 (1,2)。
    const atWall = applyMove(applyMove(newGridRunner(), "down").next, "right").next;
    expect(atWall.pos).toEqual([1, 1]);
    const move = applyMove(atWall, "right");
    expect(move.moved).toBe(false);
    expect(move.inBounds).toBe(true);
    expect(move.hitsWall).toBe(true);
    expect(move.next.pos).toEqual([1, 1]);
    expect(move.next.steps).toBe(atWall.steps + 1);
  });

  test("到达终点：atGoal 与 over 同时置真", () => {
    // (0,0) → down×4 → (4,0) → right×4 → (4,4)：底行 + 右列，绕开两个固定障碍 (1,2) / (2,3)。
    const dirs: GridDirection[] = ["down", "down", "down", "down", "right", "right", "right", "right"];
    const path = dirs.reduce((state, dir) => applyMove(state, dir).next, newGridRunner());
    expect(path.pos).toEqual([4, 4]);
    expect(path.atGoal).toBe(true);
    expect(path.over).toBe(true);
  });

  test("超过 20 步强制结束（即使没到终点）", () => {
    // 左右来回磨步数：永远不会到终点，但 20 步后必须 over。
    const dirs: GridDirection[] = ["right", "left"];
    let state = newGridRunner();
    for (let i = 0; i < GRID_STEPS_FOR_TEST; i++) {
      state = applyMove(state, dirs[i % 2]!).next;
    }
    expect(state.steps).toBe(20);
    expect(state.over).toBe(true);
    expect(state.atGoal).toBe(false);
  });
});

// 上面那个来回测试用到的步数（写常量是为了不让"20"这个魔法数在测试里散落）。
const GRID_STEPS_FOR_TEST = 20;

// `Record<string, Question>` 的索引在 strict 下是「可能不存在」的，但游乐场的问题名
// 是自己写死的（`next_move` / `action` / `risk` / `paddle_move`）—— 这里统一收窄，
// 避免每个用例都加 `!`。
function gridMoveQuestion(state: ReturnType<typeof gridRunnerQuestions>) {
  const question = state.next_move;
  if (!question || question.type !== "choice") throw new Error("expected a choice question named next_move");
  return question as SystemOneChoiceQuestion;
}

describe("grid-runner：序列化（state / questions）", () => {
  test("state 字段完整（尺寸 / 坐标 / 障碍 / 步数 / 四方向）", () => {
    const state = newGridRunner();
    const payload = gridRunnerState(state);
    expect(payload).toBeTypeOf("object");
    expect(payload).not.toBeInstanceOf(Array);
    expect(payload.grid_size).toBe(5);
    expect(payload.current).toEqual({ row: 0, col: 0 });
    expect(payload.goal).toEqual({ row: 4, col: 4 });
    expect(payload.start).toEqual({ row: 0, col: 0 });
    expect(payload.obstacles).toEqual([
      { row: 1, col: 2 },
      { row: 2, col: 3 },
    ]);
    expect(payload.steps_used).toBe(0);
    expect(payload.at_goal).toBe(false);
    expect(payload.finished).toBe(false);
    // 四个方向都在，且每个都有 in_bounds / legal 判定。
    const moves = payload.moves as Record<GridDirection, { in_bounds: boolean; legal: boolean }>;
    for (const dir of ["up", "down", "left", "right"] as const) {
      const move = moves[dir]!;
      expect(move.in_bounds).toBeTypeOf("boolean");
      expect(move.legal).toBeTypeOf("boolean");
    }
  });

  test("state 是英文（发给模型的文本不能混入 CJK）", () => {
    const payload = gridRunnerState(newGridRunner());
    const text = JSON.stringify(payload);
    expect(text).not.toMatch(/[\u4e00-\u9fa5]/);
  });

  test("state 能直接通过官方协议校验（对象形态的 state）", () => {
    const state = newGridRunner();
    const validated = validateSystemOneRequest({
      state: gridRunnerState(state),
      model: "jev-latest",
      questions: gridRunnerQuestions(state),
    });
    expect(validated.ok).toBe(true);
  });

  test("questions 是四个方向的 choice，criteria 与 state.moves 同义不矛盾", () => {
    const question = gridMoveQuestion(gridRunnerQuestions(newGridRunner()));
    expect(Object.keys(question.criteria).sort()).toEqual(["down", "left", "right", "up"]);
    // 起点 (0,0)：up / left 出界 → 说明里必须点明撞边界；down / right 可走。
    expect(String(question.criteria.up)).toMatch(/boundary|leaves the grid/);
    expect(String(question.criteria.left)).toMatch(/boundary|leaves the grid/);
    expect(String(question.criteria.down)).toMatch(/empty cell/);
    expect(String(question.criteria.right)).toMatch(/empty cell/);
  });
});

// ---------------------------------------------------------------------------
// 场景目录
// ---------------------------------------------------------------------------

describe("PLAYGROUND_SCENARIOS", () => {
  test("四个场景的 id 与 i18n key 都齐", () => {
    expect(PLAYGROUND_SCENARIOS).toHaveLength(4);
    expect(PLAYGROUND_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      "grid-runner",
      "market-replay",
      "breakout",
      "breakout-vision",
    ]);
    for (const scenario of PLAYGROUND_SCENARIOS) {
      expect(scenario.nameKey).toBeTypeOf("string");
      expect(scenario.descKey).toBeTypeOf("string");
      expect(scenario.nameKey.startsWith("jev.playground.")).toBe(true);
      expect(scenario.descKey.startsWith("jev.playground.")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 场景 A：可调盘面（边长 / 障碍数量）
// ---------------------------------------------------------------------------

/** 盘面可解 = 从起点能走到终点（测试自己写一遍 BFS，不借生成器里的那份）。 */
function solvable(size: number, walls: [number, number][]): boolean {
  const blocked = new Set(walls.map(([r, c]) => `${r},${c}`));
  const seen = new Set(["0,0"]);
  const queue: [number, number][] = [[0, 0]];
  while (queue.length > 0) {
    const [row, col] = queue.shift() as [number, number];
    if (row === size - 1 && col === size - 1) return true;
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const r = row + dr;
      const c = col + dc;
      const key = `${r},${c}`;
      if (r < 0 || c < 0 || r >= size || c >= size || blocked.has(key) || seen.has(key)) continue;
      seen.add(key);
      queue.push([r, c]);
    }
  }
  return false;
}

describe("grid-runner：盘面设置", () => {
  test("默认盘面一个字都没变（5×5、两个老障碍、20 步）", () => {
    // 这一条是给"加了设置项"上的保险：不带参数必须还是以前那局。
    const start = newGridRunner();
    expect(start.size).toBe(5);
    expect(start.goal).toEqual([4, 4]);
    expect(start.walls).toEqual([[1, 2], [2, 3]]);
    expect(start.maxSteps).toBe(20);
    expect(gridMaxSteps(5)).toBe(20);
  });

  test("终点与步数上限跟着边长走", () => {
    const big = newGridRunner({ size: 9, walls: 6 });
    expect(big.size).toBe(9);
    expect(big.goal).toEqual([8, 8]);
    // 最短路 16 步，上限给到 40 —— 撞几次墙、绕一段远路都还够。
    expect(big.maxSteps).toBe(gridMaxSteps(9));
    expect(big.maxSteps).toBeGreaterThan((9 - 1) * 2);
  });

  test("越界的设置贴边，不抛", () => {
    expect(clampGridSize(1)).toBe(GRID_SIZE_MIN);
    expect(clampGridSize(99)).toBe(GRID_SIZE_MAX);
    expect(clampGridSize(Number.NaN)).toBe(5);
    expect(clampWallCount(5, -3)).toBe(0);
    expect(clampWallCount(5, 999)).toBe(maxWallsFor(5));
    expect(newGridRunner({ size: 99, walls: 999 }).size).toBe(GRID_SIZE_MAX);
  });

  test("生成的障碍：数量对、不占起点终点、盘面可解", () => {
    for (let size = GRID_SIZE_MIN; size <= GRID_SIZE_MAX; size++) {
      for (const wanted of [0, 1, 3, maxWallsFor(size)]) {
        const walls = buildGridWalls(size, wanted);
        expect(walls.length).toBe(wanted);
        for (const [row, col] of walls) {
          expect(row).toBeGreaterThanOrEqual(0);
          expect(col).toBeGreaterThanOrEqual(0);
          expect(row).toBeLessThan(size);
          expect(col).toBeLessThan(size);
          expect([row, col]).not.toEqual([0, 0]);
          expect([row, col]).not.toEqual([size - 1, size - 1]);
        }
        // 关键：摆满上限也必须留得出一条路，否则这一局从开始就是死局。
        expect(solvable(size, walls)).toBe(true);
      }
    }
  });

  test("同一档设置永远是同一个盘面（「重置」不该换局）", () => {
    expect(buildGridWalls(8, 9)).toEqual(buildGridWalls(8, 9));
    expect(newGridRunner({ size: 7, walls: 5 }).walls).toEqual(newGridRunner({ size: 7, walls: 5 }).walls);
    // 换一档就该是另一个盘面（不然调数量看不出变化）。
    expect(buildGridWalls(8, 9)).not.toEqual(buildGridWalls(8, 10));
  });

  test("发给模型的 state 写的是这一局真正的规则（尺寸 / 上限 / 障碍）", () => {
    // 盘面调大了，state 里还写着 5x5 / 20 步的话，模型是按错的规则在判断。
    const state = newGridRunner({ size: 8, walls: 7 });
    const payload = gridRunnerState(state);
    expect(payload.grid_size).toBe(8);
    expect(payload.goal).toEqual({ row: 7, col: 7 });
    expect(payload.max_steps).toBe(state.maxSteps);
    expect(payload.task).toBe("8x8 grid pathfinding");
    expect(String(payload.description)).toContain(`${state.maxSteps} steps`);
    expect(payload.obstacles).toHaveLength(7);
  });

  test("大盘也在自己的上限处结束（步数上限跟着盘面走）", () => {
    const dirs: GridDirection[] = ["right", "left"];
    let state = newGridRunner({ size: 8, walls: 0 });
    for (let i = 0; i < state.maxSteps; i++) state = applyMove(state, dirs[i % 2]!).next;
    expect(state.steps).toBe(gridMaxSteps(8));
    expect(state.over).toBe(true);
    expect(state.atGoal).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 场景 C：market-replay（行情回放）
// ---------------------------------------------------------------------------

describe("market-data：打包进来的历史行情", () => {
  test("三个标的都解析得出来，且按日期升序、价格自洽", () => {
    for (const symbol of MARKET_SYMBOLS) {
      const bars = marketBars(symbol);
      expect(bars.length).toBeGreaterThan(1000);
      for (let i = 0; i < bars.length; i++) {
        const bar = bars[i] as MarketBar;
        expect(bar.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        // 最高价不低于开收，最低价不高于开收 —— 解析错位（把列读串）最先破的就是这条。
        expect(bar.high).toBeGreaterThanOrEqual(Math.max(bar.open, bar.close));
        expect(bar.low).toBeLessThanOrEqual(Math.min(bar.open, bar.close));
        expect(bar.close).toBeGreaterThan(0);
        expect(bar.volume).toBeGreaterThanOrEqual(0);
        const prev = bars[i - 1];
        if (prev) expect(bar.date > prev.date).toBe(true);
      }
    }
  });

  test("默认区间落在覆盖范围内，且就是最后 60 根", () => {
    for (const symbol of MARKET_SYMBOLS) {
      const span = marketSpan(symbol);
      const range = defaultMarketRange(symbol);
      expect(range.from >= span.first).toBe(true);
      expect(range.to).toBe(span.last);
      expect(clampMarketWindow(symbol, range.from, range.to).bars).toHaveLength(60);
    }
  });

  test("窗口：两端闭区间、点反了自动对调、超过上限只留靠前的部分", () => {
    const span = marketSpan("shc");
    const window = clampMarketWindow("shc", "2024-01-01", "2024-03-31");
    expect(window.bars.length).toBeGreaterThan(30);
    for (const bar of window.bars) {
      expect(bar.date >= "2024-01-01").toBe(true);
      expect(bar.date <= "2024-03-31").toBe(true);
    }
    // 第一根在全量里的下标要对得上（指标靠它往窗口之前回看）。
    expect(marketBars("shc")[window.offset]?.date).toBe(window.bars[0]?.date);
    // 反着点一样的结果。
    expect(clampMarketWindow("shc", "2024-03-31", "2024-01-01").bars).toEqual(window.bars);
    const whole = clampMarketWindow("shc", span.first, span.last);
    expect(whole.truncated).toBe(true);
    expect(whole.bars).toHaveLength(MARKET_MAX_BARS);
    expect(whole.bars[0]?.date).toBe(span.first);
    // 区间里一根都没有（周末）：空窗口而不是崩。
    expect(clampMarketWindow("shc", "2024-01-06", "2024-01-07").bars).toHaveLength(0);
  });
});

describe("market-replay：净值与仓位", () => {
  const RANGE = { symbol: "shc" as const, from: "2024-01-02", to: "2024-02-29" };

  test("开局：空仓、净值 1、判定次数 = 根数 − 1", () => {
    const start = newMarketReplay(RANGE);
    expect(start.position).toBe("flat");
    expect(start.equity).toBe(1);
    expect(start.index).toBe(0);
    expect(start.over).toBe(false);
    expect(marketSteps(start)).toBe(start.bars.length - 1);
  });

  test("区间不足两根：直接结束（界面据此提示区间太短）", () => {
    const tiny = newMarketReplay({ symbol: "shc", from: "2024-01-02", to: "2024-01-02" });
    expect(tiny.bars).toHaveLength(1);
    expect(tiny.over).toBe(true);
    expect(marketSteps(tiny)).toBe(0);
  });

  test("一直空仓：净值不动，也不收手续费", () => {
    let state = newMarketReplay(RANGE);
    while (!state.over) state = applyMarketDecision(state, "sell").next;
    expect(state.equity).toBe(1);
    expect(state.trades).toBe(0);
    expect(marketStats(state).returnPct).toBe(0);
  });

  test("第一根买入后一直持有：净值 ≈ 同区间买入持有（差的就是那一次手续费）", () => {
    let state = newMarketReplay(RANGE);
    state = applyMarketDecision(state, "buy").next;
    while (!state.over) state = applyMarketDecision(state, "hold").next;
    expect(state.trades).toBe(1);
    expect(state.position).toBe("long");
    // 净值 = (1 − 手续费) × 区间首尾收盘之比。成绩单上的两个百分数都取到两位小数，
    // 所以这里拿**没取整的** equity 去比，不然比的是四舍五入的误差。
    const first = state.bars[0] as MarketBar;
    const last = state.bars[state.bars.length - 1] as MarketBar;
    expect(state.equity).toBeCloseTo((1 - MARKET_FEE) * (last.close / first.close), 12);
    const stats = marketStats(state);
    expect(stats.returnPct).toBeCloseTo((state.equity - 1) * 100, 2);
    expect(stats.benchmarkPct).toBeCloseTo((last.close / first.close - 1) * 100, 2);
  });

  test("hold 保持原仓位，buy / sell 只在真换边时收手续费", () => {
    const start = newMarketReplay(RANGE);
    const first = applyMarketDecision(start, "buy");
    expect(first.switched).toBe(true);
    expect(first.position).toBe("long");
    // 已经是多头时再 buy：不算换仓。
    const again = applyMarketDecision(first.next, "buy");
    expect(again.switched).toBe(false);
    expect(again.next.trades).toBe(1);
    // 建仓价是"给出信号的那根"的收盘，且 hold 不会把它改掉。
    expect(first.next.entry).toBe(first.bar.close);
    const held = applyMarketDecision(again.next, "hold");
    expect(held.next.entry).toBe(first.next.entry);
    expect(held.next.position).toBe("long");
    const out = applyMarketDecision(held.next, "sell");
    expect(out.switched).toBe(true);
    expect(out.next.position).toBe("flat");
    expect(out.next.entry).toBe(0);
    expect(out.next.trades).toBe(2);
  });

  test("兑现的是下一根的收盘涨跌（不偷看未来，也不少算一天）", () => {
    const start = newMarketReplay(RANGE);
    const bars = start.bars;
    const move = applyMarketDecision(start, "buy");
    const expectedRet = (bars[1] as MarketBar).close / (bars[0] as MarketBar).close - 1;
    expect(move.ret).toBeCloseTo(expectedRet, 12);
    expect(move.equity).toBeCloseTo((1 - MARKET_FEE) * (1 + expectedRet), 12);
  });

  test("跑满：index 停在判定次数上，不会多问最后那根", () => {
    let state = newMarketReplay(RANGE);
    let steps = 0;
    while (!state.over && steps < 500) {
      state = applyMarketDecision(state, "hold").next;
      steps++;
    }
    expect(state.over).toBe(true);
    expect(steps).toBe(state.bars.length - 1);
    expect(state.index).toBe(marketSteps(state));
  });
});

describe("market-replay：发给模型的请求", () => {
  test("state / questions 过官方校验，且含成交量与仓位", () => {
    const start = newMarketReplay({ symbol: "spx", from: "2020-03-02", to: "2020-04-30" });
    const state = marketReplayState(start);
    const result = validateSystemOneRequest({
      state,
      model: "jev-latest",
      questions: marketReplayQuestions(start),
    });
    expect(result.ok).toBe(true);
    expect(state.volume_vs_20d).toBeTypeOf("number");
    expect(state.position).toBe("flat");
    expect(state.bars_total).toBe(marketSteps(start));
    // 两个问题一个 choice 一个 score —— score 是游乐场里唯一用上这个类型的地方。
    const questions = marketReplayQuestions(start);
    expect(questions.action?.type).toBe("choice");
    expect(questions.risk?.type).toBe("score");
    expect(Object.keys((questions.action as SystemOneChoiceQuestion).criteria)).toEqual([...MARKET_ACTIONS]);
    expect((questions.risk as SystemOneScoreQuestion).criteria).toHaveLength(MARKET_RISK_LEVELS.length);
  });

  test("策略：留空不写字段，填了就带上，并在 instructions 里点名", () => {
    const blank = newMarketReplay({ symbol: "shc", from: "2024-01-02", to: "2024-02-29" });
    expect(marketReplayState(blank).strategy).toBeUndefined();
    expect(String(marketActionQuestion(blank).instructions)).not.toContain("state.strategy");

    const withStrategy = newMarketReplay({
      symbol: "shc",
      from: "2024-01-02",
      to: "2024-02-29",
      strategy: "  Long only, and never add on a down day.  ",
    });
    // 前后空白要 trim 掉：用户从别处粘进来的策略经常带一堆空格 / 换行。
    expect(marketReplayState(withStrategy).strategy).toBe("Long only, and never add on a down day.");
    expect(String(marketActionQuestion(withStrategy).instructions)).toContain("state.strategy");
    // 只写空白等于没写。
    const spaces = newMarketReplay({ symbol: "shc", from: "2024-01-02", to: "2024-02-29", strategy: "   \n  " });
    expect(marketReplayState(spaces).strategy).toBeUndefined();
  });

  test("指标在全量序列上算：窗口第一根也有完整的 20 日均线", () => {
    const window = clampMarketWindow("hsi", "2023-06-01", "2023-06-30");
    const ind = marketIndicators("hsi", window.offset);
    const all = marketBars("hsi");
    const closes = all.slice(window.offset - 19, window.offset + 1).map((bar) => bar.close);
    expect(closes).toHaveLength(20);
    const ma20 = Math.round(closes.reduce((sum, value) => sum + value, 0) / 20);
    expect(ind.ma20).toBe(ma20);
    expect(ind.volumeVs20d).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 场景 D：breakout（打砖块）
// ---------------------------------------------------------------------------

/** 连跑若干次判定，动作由回调给出（模拟模型）。 */
function playBreakout(
  state: BreakoutState,
  pick: (s: BreakoutState) => BreakoutAction,
  rounds: number,
): BreakoutState {
  let current = state;
  for (let i = 0; i < rounds && !current.over; i++) current = applyBreakoutAction(current, pick(current)).next;
  return current;
}

describe("breakout：开局与设置", () => {
  test("开局：3 命、40 块砖、板子居中、未结束", () => {
    const start = newBreakout();
    expect(start.lives).toBe(BREAKOUT_LIVES);
    expect(start.bricks).toHaveLength(BREAKOUT_ROWS * BREAKOUT_COLS);
    expect(bricksLeft(start)).toBe(BREAKOUT_ROWS * BREAKOUT_COLS);
    expect(paddleCenter(start)).toBeCloseTo(BREAKOUT_W / 2, 6);
    expect(start.score).toBe(0);
    expect(start.over).toBe(false);
  });

  test("判定间隔夹在范围里", () => {
    expect(clampBreakoutEvery(0)).toBe(BREAKOUT_EVERY_MIN);
    expect(clampBreakoutEvery(99)).toBe(BREAKOUT_EVERY_MAX);
    expect(clampBreakoutEvery(Number.NaN)).toBe(5);
    expect(newBreakout({ decideEvery: 99 }).decideEvery).toBe(BREAKOUT_EVERY_MAX);
    // 1 帧一判不在可选范围里（下限是 2）：越界一律贴边，不是原样放行。
    expect(newBreakout({ decideEvery: 1 }).decideEvery).toBe(BREAKOUT_EVERY_MIN);
  });

  test("同样的动作序列跑两次，结果一模一样（没有随机数）", () => {
    const pick = (s: BreakoutState): BreakoutAction =>
      predictLanding(s.ball).x > paddleCenter(s) ? "right" : "left";
    const a = playBreakout(newBreakout(), pick, 40);
    const b = playBreakout(newBreakout(), pick, 40);
    expect(a.score).toBe(b.score);
    expect(a.lives).toBe(b.lives);
    expect(a.ball).toEqual(b.ball);
    expect(a.paddleX).toBe(b.paddleX);
  });
});

describe("breakout：一次判定 = 一段帧", () => {
  test("推进的帧数就是判定间隔，每帧都记下球与板子", () => {
    const start = newBreakout({ decideEvery: 4 });
    const move = applyBreakoutAction(start, "right");
    expect(move.next.frame).toBe(4);
    expect(move.next.decisions).toBe(1);
    // 帧表含起始那一帧，所以是 帧数 + 1 条。
    expect(move.frames).toHaveLength(5);
    // 板子的位置必须**逐帧**记下来 —— 只记球的话，界面上板子只能画在这一段的
    // 终点位置，每隔一次判定瞬移一次，看着就是"板子没动"。
    const paddles = move.frames.map((frame) => frame.paddleX);
    expect(paddles[0]).toBe(start.paddleX);
    expect(paddles[4]).toBe(move.next.paddleX);
    for (let i = 1; i < paddles.length; i++) {
      expect((paddles[i] as number) - (paddles[i - 1] as number)).toBeCloseTo(3.2, 6);
    }
    // 没漏球的一段里不该有"发球"标记（有的话界面会把轨迹切断）。
    expect(move.frames.some((frame) => frame.served)).toBe(false);
  });

  test("漏球之后那一帧打上 served：位置是跳过去的，界面据此断开轨迹", () => {
    // 板子躲到最左边，球放在右下角直奔底线。
    let state: BreakoutState = {
      ...newBreakout({ decideEvery: 6 }),
      paddleX: 2,
      ball: { x: 260, y: 180, vx: 1.2, vy: 2.6 },
    };
    let served: BreakoutFrame | undefined;
    for (let i = 0; i < 10 && !served; i++) {
      const move = applyBreakoutAction(state, "stay");
      served = move.frames.find((frame) => frame.served);
      state = move.next;
    }
    expect(served).toBeDefined();
    // 打上标记的那一帧就是重新发的球：已经回到场地中段，离底线远得很。
    expect((served as BreakoutFrame).y).toBeLessThan(BREAKOUT_H - 40);
    expect(state.misses).toBeGreaterThan(0);
    expect(state.lives).toBeLessThan(BREAKOUT_LIVES);
  });

  test("left / right 整段都在挪板子，stay 一动不动", () => {
    const start = newBreakout({ decideEvery: 5 });
    const left = applyBreakoutAction(start, "left").next;
    const right = applyBreakoutAction(start, "right").next;
    const stay = applyBreakoutAction(start, "stay").next;
    expect(left.paddleX).toBeCloseTo(start.paddleX - 5 * 3.2, 6);
    expect(right.paddleX).toBeCloseTo(start.paddleX + 5 * 3.2, 6);
    expect(stay.paddleX).toBe(start.paddleX);
  });

  test("板子撞到边就停住，不会跑出场地", () => {
    const far = playBreakout(newBreakout(), () => "left", 30);
    expect(far.paddleX).toBeGreaterThanOrEqual(2);
    const other = playBreakout(newBreakout(), () => "right", 30);
    expect(other.paddleX + BREAKOUT_PADDLE_W).toBeLessThanOrEqual(BREAKOUT_W - 2);
  });

  test("球始终在场地左右边界之内（反射不会漏算）", () => {
    let state = newBreakout({ decideEvery: 3 });
    for (let i = 0; i < 60 && !state.over; i++) {
      const move = applyBreakoutAction(state, i % 2 === 0 ? "left" : "right");
      for (const { x } of move.frames) {
        expect(x).toBeGreaterThanOrEqual(BREAKOUT_BALL_R - 0.001);
        expect(x).toBeLessThanOrEqual(BREAKOUT_W - BREAKOUT_BALL_R + 0.001);
      }
      state = move.next;
    }
  });
});

describe("breakout：计分、命数与收场", () => {
  test("打到砖：砖少了、分数涨、球反弹回来", () => {
    // 让球从砖阵**下方**直上飞过去，跑到打中为止 —— 球必须从外面撞上来，起点塞在
    // 砖堆里的话它会在砖缝里连撞好几下，测的就不是"撞一次砖会怎样"了。
    let state: BreakoutState = { ...newBreakout({ decideEvery: 2 }), ball: { x: 40, y: 110, vx: 0, vy: -2.2 } };
    let before = bricksLeft(state);
    let broke = 0;
    for (let i = 0; i < 20 && broke === 0; i++) {
      before = bricksLeft(state);
      const move = applyBreakoutAction(state, "stay");
      broke = move.broken;
      state = move.next;
    }
    expect(broke).toBeGreaterThan(0);
    // `broken` 报的必须就是真少掉的块数（别再拿分数差去除以 10 —— 每行分值不同）。
    expect(bricksLeft(state)).toBe(before - broke);
    expect(state.score).toBeGreaterThan(0);
    // 打中之后球改朝下（撞的是砖的底面）。
    expect(state.ball.vy).toBeGreaterThan(0);
  });

  test("漏球扣一条命，三条用完就结束", () => {
    // 板子一直往左躲，球必然漏掉。
    const state = playBreakout(newBreakout({ decideEvery: 6 }), () => "left", BREAKOUT_MAX_DECISIONS);
    expect(state.misses).toBeGreaterThan(0);
    expect(state.over).toBe(true);
    expect(state.lives).toBe(0);
    expect(breakoutStats(state).lives).toBe(0);
  });

  test("判定次数到上限就收场（一局不会无限跑下去）", () => {
    // 跟着落点走 = 基本不会漏球，所以结束的原因只能是判定次数用完。
    const state = playBreakout(
      newBreakout({ decideEvery: 2 }),
      (s) => {
        const offset = predictLanding(s.ball).x - paddleCenter(s);
        return Math.abs(offset) < 4 ? "stay" : offset > 0 ? "right" : "left";
      },
      BREAKOUT_MAX_DECISIONS + 10,
    );
    expect(state.over).toBe(true);
    expect(state.decisions).toBeLessThanOrEqual(BREAKOUT_MAX_DECISIONS);
    // 会接球（这条同时证明板子跟得上、接球判定有效）。
    expect(state.hits).toBeGreaterThan(0);
  });
});

describe("breakout：落点预测与请求", () => {
  test("预测的落点和真把球推过去落的地方一致", () => {
    // 球放在砖阵**下方**、朝右下飞，板子躲到最左边：一路不碰砖也不会被接住，
    // 中途撞一次右墙 —— 正好把反射那段也验了。
    // （不能改成"把砖全打掉"来腾地方：砖清光 = cleared = 这一局当场结束。）
    const every = BREAKOUT_EVERY_MIN;
    const clean: BreakoutState = {
      ...newBreakout({ decideEvery: every }),
      paddleX: 2,
      ball: { x: 250, y: 120, vx: 2.6, vy: 2.2 },
    };
    const predicted = predictLanding(clean.ball);
    let state = clean;
    let decisions = 0;
    while (decisions < 300) {
      state = applyBreakoutAction(state, "stay").next;
      decisions++;
      if (state.ball.y >= 194 - BREAKOUT_BALL_R && state.ball.vy > 0) break;
    }
    // 判定是按段推进的（一段 `every` 帧），所以落点最多差一段的位移 —— 对得上
    // 预测就说明反射那几下算对了，这正是要守的东西。
    const drift = Math.abs(2.6) * every;
    expect(Math.abs(state.ball.x - predicted.x)).toBeLessThanOrEqual(drift);
    expect(Math.abs(decisions * every - predicted.frames)).toBeLessThanOrEqual(every);
  });

  test("state / questions 过官方校验，且带上真正的信号", () => {
    const start = newBreakout({ decideEvery: 5 });
    const state = breakoutState(start);
    const result = validateSystemOneRequest({ state, model: "jev-latest", questions: breakoutQuestions(start) });
    expect(result.ok).toBe(true);
    expect(state.landing_minus_paddle_center).toBeTypeOf("number");
    expect(state.paddle_reach_per_decision).toBeCloseTo(16, 6);
    expect(state.bricks_left).toBe(BREAKOUT_ROWS * BREAKOUT_COLS);
    // 开局板子居中，两边都没贴墙。
    expect(state.paddle_at_left_edge).toBe(false);
    expect(state.paddle_at_right_edge).toBe(false);
    const questions = breakoutQuestions(start);
    expect(Object.keys((questions.paddle_move as SystemOneChoiceQuestion).criteria)).toEqual([...BREAKOUT_ACTIONS]);
  });

  test("贴墙时 state 要说出来（模型看不见就会一直顶着墙空转）", () => {
    let state = newBreakout({ decideEvery: 5 });
    for (let i = 0; i < 20; i++) state = applyBreakoutAction(state, "left").next;
    const left = breakoutState(state);
    expect(left.paddle_at_left_edge).toBe(true);
    expect(left.paddle_at_right_edge).toBe(false);
  });

  test("三个选项的说明必须互不相同，且各自点名落点在哪一侧", () => {
    const criteria = (breakoutQuestions(newBreakout()).paddle_move as SystemOneChoiceQuestion).criteria;
    const left = String(criteria.left);
    const right = String(criteria.right);
    const stay = String(criteria.stay);
    // 这是这个场景踩过的坑：left / right 只差一个方向词时，判定模型没有可分辨的
    // 信号，一整局都会选同一边，板子顶死在墙上再也不回来。
    expect(left).not.toBe(right);
    expect(left).toContain("negative");
    expect(right).toContain("positive");
    expect(left).toContain("paddle_at_left_edge");
    expect(right).toContain("paddle_at_right_edge");
    expect(stay).toContain("landing_minus_paddle_center");
  });
});

describe("breakout-vision：只给图，不给数字", () => {
  const IMAGE = "data:image/png;base64,AAAB";

  test("state 是 chat 形状，图片只以引用出现，一个数字字段都不带", () => {
    const game = newBreakout({ decideEvery: 5 });
    const state = breakoutVisionState(game, IMAGE);
    const result = validateSystemOneRequest({
      state,
      model: "jev-latest",
      questions: breakoutVisionQuestions(game),
    });
    expect(result.ok).toBe(true);
    const messages = state.messages as { role: string; content: Record<string, unknown>[] }[];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    const parts = messages[0]!.content;
    expect(parts.map((part) => part.type)).toEqual(["text", "image_url"]);
    expect(parts[1]?.image_url).toEqual({ url: IMAGE });
    // 图**不能**出现在任何文本里：拼进去就退化成几万个 base64 文本 token，
    // 那正是这个场景要证伪的东西。
    expect(String(parts[0]?.text)).not.toContain("base64");
    // 数字版里那些算好的信号（落点、速度、离板心多远）一个都不许漏进来。
    const text = JSON.stringify(parts[0]);
    for (const leak of ["predicted", "landing", "paddle_x", "velocity", "ball_"]) {
      expect(text).not.toContain(leak);
    }
  });

  test("三个选项说的都是「图上看起来怎样」，不提任何 state 字段名", () => {
    const game = newBreakout({ decideEvery: 5 });
    const criteria = (breakoutVisionQuestions(game).paddle_move as SystemOneChoiceQuestion).criteria;
    expect(Object.keys(criteria)).toEqual([...BREAKOUT_ACTIONS]);
    for (const [, description] of Object.entries(criteria)) {
      expect(String(description)).toContain("picture");
      // 提到字段名就等于把数字版的答案用文字喂回去了。
      expect(String(description)).not.toContain("landing_minus_paddle_center");
    }
    expect(String(criteria.left)).toContain("LEFT");
    expect(String(criteria.right)).toContain("RIGHT");
  });

  test("同一局面下，视觉版与数字版问的是同一件事、用的是同一套动作", () => {
    const game = newBreakout({ decideEvery: 5 });
    expect(Object.keys(breakoutVisionQuestions(game))).toEqual(Object.keys(breakoutQuestions(game)));
  });

  test("板子贴墙时不给「往墙里推」：那一步白推，正是板子卡在边上不动的来源", () => {
    const game = newBreakout({ decideEvery: 5 });
    const options = (state: BreakoutState) =>
      Object.keys((breakoutVisionQuestions(state).paddle_move as SystemOneChoiceQuestion).criteria);
    expect(options(game)).toEqual(["left", "stay", "right"]);
    // 一直往右推到夹住为止
    let right = game;
    for (let i = 0; i < 40; i++) right = applyBreakoutAction(right, "right").next;
    expect(paddleAtRightWall(right)).toBe(true);
    expect(options(right)).toEqual(["left", "stay"]);
    let left = game;
    for (let i = 0; i < 40; i++) left = applyBreakoutAction(left, "left").next;
    expect(paddleAtLeftWall(left)).toBe(true);
    expect(options(left)).toEqual(["stay", "right"]);
    // 两个都还是合法请求
    for (const state of [right, left]) {
      const result = validateSystemOneRequest({
        state: breakoutVisionState(state, IMAGE),
        model: "jev-latest",
        questions: breakoutVisionQuestions(state),
      });
      expect(result.ok).toBe(true);
    }
  });

  test("掷硬币：左右排前两名且差不到 0.2 才算；贴墙只剩两项、或有一边明显占优都不算", () => {
    // 实测 35B 的典型一步
    expect(isBreakoutCoinFlip({ left: 0.46, stay: 0.09, right: 0.46 })).toBe(true);
    expect(isBreakoutCoinFlip({ left: 0.51, stay: 0.09, right: 0.4 })).toBe(true);
    expect(isBreakoutCoinFlip({ left: 0.23, stay: 0.07, right: 0.7 })).toBe(false);
    // "不动"排第一，左右只是并列第二 —— 那是它看出来了要守住，不是掷硬币
    expect(isBreakoutCoinFlip({ left: 0.2, stay: 0.62, right: 0.18 })).toBe(false);
    // 贴墙：只剩两项
    expect(isBreakoutCoinFlip({ left: 0.5, stay: 0.5 })).toBe(false);
    expect(isBreakoutCoinFlip({})).toBe(false);
  });
});
