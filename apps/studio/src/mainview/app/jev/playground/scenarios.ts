/**
 * 游乐场（Playground）的内置场景 —— **纯逻辑层**。
 *
 * 与侧栏内置示例（`../examples.ts`）的分工：那边是"给编辑器装一份请求"，这里是
 * "自动跑完一串判定，把每一步摊开看"。所以本文件只有纯函数：局面推进、请求构造、
 * 结果统计，不含任何 React / rpcClient —— UI（Task 2/3）负责按自己的节奏调
 * `rpcClient.systemoneRun` 并拿这里的数据来渲染。
 *
 * **发给模型的文本一律英文**：JEV 官方模型卡写明主训练语言是英语，CJK 准确率明显更低。
 * 游乐场要展示模型的"真实表现"，场景数据里掺中文会把展示结果拖下水；界面文案才走 i18n
 * 双语（`nameKey` / `descKey`，Task 3 补文案）。
 *
 * 注意 RPC 侧 `state` 的参数类型是 `string`：这里的序列化函数返回对象（协议本身允许
 * 对象），发请求前在 UI 层 `JSON.stringify` 即可，纯逻辑层不替调用方做这步。
 */
import type {
  SystemOneChoiceQuestion,
  SystemOneQuestions,
  SystemOneScoreQuestion,
} from "../../../../shared/systemone";
import {
  clampMarketWindow,
  marketBars,
  MARKET_META,
  type MarketBar,
  type MarketSymbol,
} from "./market-data";
// ---------------------------------------------------------------------------
// 场景 A：grid-runner（5×5 网格寻路 —— 连续决策）
//
// 每一步都是一次独立的 `systemoneRun`：state 随局面变化，问题也随局面变化（撞墙 /
// 撞障碍的方向会在 criteria 里被点名）。跑完一条轨迹后，用户能看到"同一类问题
// 在不同局面下，模型的选择与置信度如何漂移"。
// ---------------------------------------------------------------------------

export type GridDirection = "up" | "down" | "left" | "right";

/** 方向 → 行 / 列偏移（行 0 是上边）。 */
const GRID_DELTA: Record<GridDirection, [number, number]> = {
  up: [-1, 0],
  down: [1, 0],
  left: [0, -1],
  right: [0, 1],
};

/**
 * 固定的两个障碍：(1,2) 与 (2,3)。
 *
 * 选它们的原因：都离起点不远（几步之内就会真的撞上去，模型才有机会"看"到障碍），
 * 又都不堵死任何一行一列 —— 存在大量可行路线（可解）。
 */
export const GRID_SIZE = 5;
export const GRID_START: [number, number] = [0, 0];
export const GRID_GOAL: [number, number] = [4, 4];
export const GRID_WALLS: readonly [number, number][] = [[1, 2], [2, 3]];
/** 默认尺寸（5×5）下的步数上限；别的尺寸走 `gridMaxSteps`。 */
export const GRID_MAX_STEPS = 20;

/**
 * 可调范围。下限 4 是"还能看出寻路"的最小盘，上限 10 是格子缩到看不清之前的极限
 * （10×10 = 100 格，每步仍只问一个四选一的问题，跑满也就几十次判定）。
 */
export const GRID_SIZE_MIN = 4;
export const GRID_SIZE_MAX = 10;

/**
 * 步数上限随盘面走：最短路是 `2 * (size - 1)` 步，给两倍半的余量 —— 够撞几次墙、
 * 绕一段远路，又不至于让一条走不出去的轨迹拖到几十次判定。
 * 默认的 5×5 正好回到 20，和以前一模一样。
 */
export function gridMaxSteps(size: number): number {
  return (size - 1) * 5;
}

/**
 * 一个盘面最多摆几个障碍：四分之一的格子。再多就很容易把盘面切成两半 —— 那时
 * 生成器只能一个个试着放弃，用户拖到头却发现障碍没变多，不如把上限说清楚。
 */
export function maxWallsFor(size: number): number {
  return Math.floor((size * size) / 4);
}

/** 值夹在范围里（界面传进来的都是用户点出来的，越界就贴边）。 */
export function clampGridSize(size: number): number {
  if (!Number.isFinite(size)) return GRID_SIZE;
  return Math.min(GRID_SIZE_MAX, Math.max(GRID_SIZE_MIN, Math.floor(size)));
}

export function clampWallCount(size: number, count: number): number {
  if (!Number.isFinite(count)) return 0;
  return Math.min(maxWallsFor(size), Math.max(0, Math.floor(count)));
}

export type GridRunnerState = {
  size: number;
  /** [row, col]，行 0 在上、列 0 在左。 */
  pos: [number, number];
  goal: [number, number];
  walls: [number, number][];
  /** 已经用掉的步数（非法移动也计数 —— 撞墙也是有代价的，这正是想展示给用户的）。 */
  steps: number;
  /** 这一局的步数上限（随尺寸变，见 `gridMaxSteps`）。 */
  maxSteps: number;
  atGoal: boolean;
  over: boolean;
};

export type GridRunnerMove = {
  next: GridRunnerState;
  /** 移动后是否还在界内（撞墙 = false）。 */
  inBounds: boolean;
  /** 目标格是否是障碍。 */
  hitsWall: boolean;
  target: [number, number];
  /** 撞墙 / 撞障碍：位置不变，但步数照计。 */
  moved: boolean;
};

/** 32 位小 PRNG：同样的 seed 永远给同一串数，所以"同一档设置 = 同一个盘面"。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 起点能不能走到终点（BFS，把 `walls` 当不可通行）。 */
function gridSolvable(size: number, walls: readonly [number, number][]): boolean {
  const blocked = new Set(walls.map(([r, c]) => `${r},${c}`));
  const goal = `${size - 1},${size - 1}`;
  if (blocked.has("0,0") || blocked.has(goal)) return false;
  const seen = new Set(["0,0"]);
  const queue: [number, number][] = [[0, 0]];
  while (queue.length > 0) {
    const [row, col] = queue.shift() as [number, number];
    if (`${row},${col}` === goal) return true;
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const r = row + dr;
      const c = col + dc;
      const key = `${r},${c}`;
      if (r < 0 || c < 0 || r >= size || c >= size) continue;
      if (blocked.has(key) || seen.has(key)) continue;
      seen.add(key);
      queue.push([r, c]);
    }
  }
  return false;
}

/**
 * 按尺寸与数量摆障碍。
 *
 * 两条硬要求：**盘面必须可解**（每放一个都用 BFS 验一遍，堵死了就换一格），
 * 同一档设置**必须摆出同一个盘面**（seed 只由 size 与 count 决定）—— 否则用户
 * 点一下「重置」盘面就变了，没法比较"同一局面下模型的选择"。
 *
 * 起点与终点不放障碍；要的数量放不下时就放到放不下为止（上限见 `maxWallsFor`）。
 */
export function buildGridWalls(size: number, count: number): [number, number][] {
  const wanted = clampWallCount(size, count);
  if (wanted === 0) return [];
  const cells: [number, number][] = [];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (row === 0 && col === 0) continue;
      if (row === size - 1 && col === size - 1) continue;
      cells.push([row, col]);
    }
  }
  // Fisher–Yates，随机源是那个定死 seed 的 PRNG。
  const rand = mulberry32(size * 1000 + wanted);
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const a = cells[i] as [number, number];
    const b = cells[j] as [number, number];
    cells[i] = b;
    cells[j] = a;
  }
  const walls: [number, number][] = [];
  for (const cell of cells) {
    if (walls.length >= wanted) break;
    const candidate: [number, number][] = [...walls, cell];
    if (gridSolvable(size, candidate)) walls.push(cell);
  }
  return walls.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/**
 * 开局（纯函数：任何时刻可以从一个局面重新开局）。
 *
 * 不带参数就是默认的 5×5 两障碍 —— 那两个位置 (1,2) / (2,3) 是挑过的（见上面的
 * 注释），不交给生成器重摆。改过尺寸或障碍数才按设置生成。
 */
export function newGridRunner(options?: { size?: number; walls?: number }): GridRunnerState {
  const size = clampGridSize(options?.size ?? GRID_SIZE);
  const wallCount = clampWallCount(size, options?.walls ?? GRID_WALLS.length);
  const isDefault = size === GRID_SIZE && wallCount === GRID_WALLS.length;
  return {
    size,
    pos: [...GRID_START],
    goal: [size - 1, size - 1],
    walls: isDefault ? GRID_WALLS.map(([r, c]) => [r, c]) : buildGridWalls(size, wallCount),
    steps: 0,
    maxSteps: gridMaxSteps(size),
    atGoal: false,
    over: false,
  };
}

function isWall(state: GridRunnerState, row: number, col: number): boolean {
  return state.walls.some(([r, c]) => r === row && c === col);
}

/**
 * 局面 → JEV 的 `state`（英文 JSON **对象**，不拍平成字符串）。
 *
 * 字段刻意把"四个方向各自会走到哪、是否可走"摊开：JEV 是 encoder 类小模型，
 * 把可推导的信息直接写进 state 比指望它自己算坐标差值稳得多。
 */
export function gridRunnerState(state: GridRunnerState): Record<string, unknown> {
  const { size, pos, goal, walls, steps, over, atGoal } = state;
  return {
    // 盘面大小与步数上限都跟着设置走：state 里写的数字必须就是这一局真正的规则，
    // 不然模型按"20 步"盘算，实际却在第 45 步才结束。
    task: `${size}x${size} grid pathfinding`,
    description:
      "A single agent moves on a grid. It starts at the start cell and must reach the goal cell. " +
      "It may move one cell per step: up, down, left or right. A step into a wall or an obstacle " +
      "does not move the agent, but it still costs one step. The walk ends when the agent reaches " +
      `the goal cell, or when it has used more than ${state.maxSteps} steps.`,
    grid_size: size,
    start: { row: GRID_START[0], col: GRID_START[1] },
    current: { row: pos[0], col: pos[1] },
    goal: { row: goal[0], col: goal[1] },
    obstacles: walls.map(([row, col]) => ({ row, col })),
    steps_used: steps,
    max_steps: state.maxSteps,
    at_goal: atGoal,
    finished: over,
    moves: {
      // 顺序固定：界面与模型看到的顺序一致。
      up: gridMoveInfo(state, "up"),
      down: gridMoveInfo(state, "down"),
      left: gridMoveInfo(state, "left"),
      right: gridMoveInfo(state, "right"),
    },
  };
}

function gridMoveInfo(state: GridRunnerState, dir: GridDirection) {
  const [dr, dc] = GRID_DELTA[dir];
  const row = state.pos[0] + dr;
  const col = state.pos[1] + dc;
  const inBounds = row >= 0 && row < state.size && col >= 0 && col < state.size;
  if (!inBounds) {
    return {
      direction: dir,
      in_bounds: false,
      target: null,
      blocked: "wall",
      legal: false,
      note: `Stepping ${dir} leaves the grid (hits the boundary). The agent would stay in place, but the step still counts.`,
    };
  }
  const hitsWall = isWall(state, row, col);
  return {
    direction: dir,
    in_bounds: true,
    target: { row, col },
    blocked: hitsWall ? "obstacle" : null,
    legal: !hitsWall,
    note: hitsWall
      ? `Stepping ${dir} would land on the obstacle at row ${row}, col ${col}. The agent would stay in place, but the step still counts.`
      : `Stepping ${dir} would land on the empty cell at row ${row}, col ${col}.`,
  };
}

/**
 * 局面 → `questions`：一个 `choice`，四个方向各一条英文说明。
 *
 * 说明里带上"会走到哪个格子 / 撞墙还是撞障碍"，与 state.moves 里的 note 同源
 * （共用 `gridMoveInfo`）—— state 和 criteria 不能互相矛盾，否则模型只能猜谁是对的。
 */
export function gridRunnerQuestions(state: GridRunnerState): SystemOneQuestions {
  return {
    next_move: gridChoiceQuestion(state),
  };
}

/** 独立导出：UI 可能只想要"问题本身"（不想要整份 questions 包裹）。 */
export function gridChoiceQuestion(state: GridRunnerState): SystemOneChoiceQuestion {
  return {
    type: "choice",
    instructions:
      "Which direction should the agent move next? Pick the move that makes the most progress " +
      "toward the goal while staying clear of walls and obstacles.",
    criteria: {
      up: gridMoveInfo(state, "up").note,
      down: gridMoveInfo(state, "down").note,
      left: gridMoveInfo(state, "left").note,
      right: gridMoveInfo(state, "right").note,
    },
  };
}

/** 推进一步（纯函数、不可变更新）；非法移动位置不变但计步。 */
export function applyMove(state: GridRunnerState, direction: GridDirection): GridRunnerMove {
  const [dr, dc] = GRID_DELTA[direction];
  const row = state.pos[0] + dr;
  const col = state.pos[1] + dc;
  const inBounds = row >= 0 && row < state.size && col >= 0 && col < state.size;
  const hitsWall = inBounds && isWall(state, row, col);
  const moved = inBounds && !hitsWall;

  const steps = state.steps + 1;
  const next: GridRunnerState = {
    ...state,
    pos: moved ? [row, col] : [...state.pos],
    steps,
    atGoal: moved && row === state.goal[0] && col === state.goal[1],
  };
  next.over = next.atGoal || steps >= next.maxSteps;
  return { next, inBounds, hitsWall, target: [row, col], moved };
}

// ---------------------------------------------------------------------------
// 场景 C：market-replay（行情回放 —— 连续决策 + 可算成绩 + 用户给的条件）
//
// 一根真实日线 = 一次判定：问方向（choice）与风险档位（score）。信号在**收盘时**
// 给出，收益按**下一根**的收盘算 —— 这样既不偷看未来，也不需要盘中数据。
// 跑完可以拿策略净值和"买入持有"对照：这是游乐场里唯一一个有客观外部基准的场景。
//
// 用户可以写一段自己的策略（可留空）。它作为 `state.strategy` 单独一个字段进去，
// instructions 里点名说"这是交易者写下的偏好"—— 不是把它拼进 instructions 正文：
// 那等于让一段用户自由文本改写任务本身的定义，一旦有人写"忽略上面的规则"就没法收场。
// ---------------------------------------------------------------------------

export type MarketAction = "buy" | "hold" | "sell";

export const MARKET_ACTIONS: readonly MarketAction[] = ["buy", "hold", "sell"];

/**
 * 单边手续费（换一次仓位收一次）。0.05% 是个偏保守的整数档：不收手续费的话，
 * "每天翻来覆去换仓"在净值上不吃任何亏，跑出来的成绩会好看得不真实。
 */
export const MARKET_FEE = 0.0005;

/**
 * 风险档位（`score` 问题）。**有序**，档位号就是下标 —— 0 最平静、3 最紧张。
 * 游乐场里前两个场景都没用上 `score`，这里补上协议的第三种问题类型。
 */
export const MARKET_RISK_LEVELS: readonly string[] = [
  "Calm: small range, volume near its average, price sitting close to the 20-day average.",
  "Normal: ordinary day-to-day movement, nothing that changes how a position should be sized.",
  "Elevated: wide range or unusual volume, or price stretched well away from the 20-day average.",
  "Stress: a large move against a backdrop of heavy volume, or a sharp drop from the recent high.",
];

/** 回放现场。`index` 是"下一根要判定的日线"在 `bars` 里的下标。 */
export type MarketReplayState = {
  symbol: MarketSymbol;
  from: string;
  to: string;
  /** 用户写的策略（已 trim）；空串 = 不附加条件。 */
  strategy: string;
  /** 回放窗口内的日线（升序）。 */
  bars: readonly MarketBar[];
  /** 窗口第一根在全量序列里的下标 —— 指标要往窗口之前回看。 */
  offset: number;
  index: number;
  position: "long" | "flat";
  /** 建仓价（`flat` 时为 0）。 */
  entry: number;
  /** 策略净值，开局 1。 */
  equity: number;
  /** 换仓次数（收过手续费的那些）。 */
  trades: number;
  over: boolean;
};

/**
 * 能判定的根数 = 窗口根数 − 1。
 *
 * 最后一根没有"下一根"来兑现收益，所以不问它 —— 否则最后一步的答案既不影响净值
 * 也无法验证，纯粹是一次白跑的调用。
 */
export function marketSteps(state: MarketReplayState): number {
  return Math.max(0, state.bars.length - 1);
}

/** 开局（纯函数）。窗口为空或只有一根时直接是 `over`，界面据此提示区间太短。 */
export function newMarketReplay(options: {
  symbol: MarketSymbol;
  from: string;
  to: string;
  strategy?: string;
}): MarketReplayState {
  const window = clampMarketWindow(options.symbol, options.from, options.to);
  return {
    symbol: options.symbol,
    from: options.from,
    to: options.to,
    strategy: (options.strategy ?? "").trim(),
    bars: window.bars,
    offset: window.offset,
    index: 0,
    position: "flat",
    entry: 0,
    equity: 1,
    trades: 0,
    over: window.bars.length < 2,
  };
}

/** 当前这根（`over` 之后返回最后一根，调用方不用到处判空）。 */
export function marketCurrentBar(state: MarketReplayState): MarketBar | null {
  const bar = state.bars[Math.min(state.index, state.bars.length - 1)];
  return bar ?? null;
}

export type MarketIndicators = {
  changePct: number;
  ma5: number;
  ma20: number;
  vsMa20Pct: number;
  rangePct: number;
  volumeVs20d: number;
  high20: number;
  low20: number;
  drawdownPct: number;
  /** 连涨（正）/ 连跌（负）的天数。 */
  streak: number;
};

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * 指标：都在**全量序列**上算（`absolute` 是全量下标），不是只在回放窗口里算。
 *
 * 这样窗口第一根就有完整的 20 日均线 —— 否则用户把区间掐在某一天，头二十根的
 * 指标全是"只有几根数据的均值"，模型看到的和图上画的对不上。
 */
export function marketIndicators(symbol: MarketSymbol, absolute: number): MarketIndicators {
  const all = marketBars(symbol);
  const bar = all[absolute];
  if (!bar) {
    return { changePct: 0, ma5: 0, ma20: 0, vsMa20Pct: 0, rangePct: 0, volumeVs20d: 1, high20: 0, low20: 0, drawdownPct: 0, streak: 0 };
  }
  const prev = all[absolute - 1];
  const back = (n: number) => all.slice(Math.max(0, absolute - n + 1), absolute + 1);
  const closes = back(20).map((item) => item.close);
  const ma5 = mean(back(5).map((item) => item.close));
  const ma20 = mean(closes);
  const volumes = back(20).map((item) => item.volume);
  const avgVolume = mean(volumes);
  const high20 = Math.max(...back(20).map((item) => item.high));
  const low20 = Math.min(...back(20).map((item) => item.low));
  let streak = 0;
  for (let i = absolute; i > 0; i--) {
    const cur = all[i];
    const before = all[i - 1];
    if (!cur || !before) break;
    const up = cur.close >= before.close;
    if (streak === 0) streak = up ? 1 : -1;
    else if (up && streak > 0) streak += 1;
    else if (!up && streak < 0) streak -= 1;
    else break;
  }
  return {
    changePct: prev ? round2(((bar.close - prev.close) / prev.close) * 100) : 0,
    ma5: Math.round(ma5),
    ma20: Math.round(ma20),
    vsMa20Pct: ma20 > 0 ? round2(((bar.close - ma20) / ma20) * 100) : 0,
    rangePct: bar.close > 0 ? round2(((bar.high - bar.low) / bar.close) * 100) : 0,
    volumeVs20d: avgVolume > 0 ? round2(bar.volume / avgVolume) : 1,
    high20,
    low20,
    drawdownPct: high20 > 0 ? round2(((bar.close - high20) / high20) * 100) : 0,
    streak,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 局面 → JEV 的 `state`（英文对象）。
 *
 * 和网格场景同一个原则：能算的都替它算好（涨跌幅、相对量、离均线多远、回撤），
 * encoder 类小模型不会自己做这些算术。成交量给的是**对 20 日均量的倍数**而不是
 * 绝对值 —— 各市场口径不同，绝对值对模型没有意义（见 `market-data.ts` 文件头）。
 */
export function marketReplayState(state: MarketReplayState): Record<string, unknown> {
  const bar = marketCurrentBar(state);
  const meta = MARKET_META[state.symbol];
  if (!bar) return { task: "Index daily replay", description: "No bars in the selected range." };
  const absolute = state.offset + Math.min(state.index, state.bars.length - 1);
  const ind = marketIndicators(state.symbol, absolute);
  const all = marketBars(state.symbol);
  const recent = all.slice(Math.max(0, absolute - 4), absolute + 1).map((item, i, rows) => {
    const before = rows[i - 1];
    return {
      date: item.date,
      close: item.close,
      change_pct: before ? round2(((item.close - before.close) / before.close) * 100) : null,
    };
  });
  const payload: Record<string, unknown> = {
    task: "Daily index replay",
    description:
      "One trading day of a stock index is shown. Decide what the position should be for the next " +
      "trading day. The decision is made on today's close and takes effect on the next close, so no " +
      "future information is available. Answer from the numbers below only.",
    symbol: { code: meta.code, name: meta.name, market: meta.market, currency: meta.currency },
    date: bar.date,
    bar: { open: bar.open, high: bar.high, low: bar.low, close: bar.close },
    change_pct: ind.changePct,
    // 相对量：1.0 = 与近 20 日均量持平，2.0 = 放量一倍。
    volume_vs_20d: ind.volumeVs20d,
    ma5: ind.ma5,
    ma20: ind.ma20,
    close_vs_ma20_pct: ind.vsMa20Pct,
    day_range_pct: ind.rangePct,
    high_20d: ind.high20,
    low_20d: ind.low20,
    drawdown_from_20d_high_pct: ind.drawdownPct,
    // 正数 = 连涨几天，负数 = 连跌几天。
    streak_days: ind.streak,
    recent_days: recent,
    position: state.position,
    entry_price: state.position === "long" ? state.entry : null,
    unrealized_pct:
      state.position === "long" && state.entry > 0 ? round2(((bar.close - state.entry) / state.entry) * 100) : null,
    bars_done: state.index,
    bars_total: marketSteps(state),
    fee_per_switch_pct: round2(MARKET_FEE * 100),
  };
  // 空策略不写字段：让模型看到一个空字符串，等于凭空给它一条"没有内容的规则"。
  if (state.strategy) payload.strategy = state.strategy;
  return payload;
}

export function marketReplayQuestions(state: MarketReplayState): SystemOneQuestions {
  return {
    action: marketActionQuestion(state),
    risk: marketRiskQuestion(),
  };
}

/**
 * 方向题。带策略时在 instructions 末尾加一句：策略是**交易者写下的偏好**，
 * 按它裁剪选择 —— 措辞上把它钉死在"数据"的位置，而不是任务定义的一部分。
 */
export function marketActionQuestion(state: MarketReplayState): SystemOneChoiceQuestion {
  const base =
    "What should the position be for the next trading day? The position is either long (fully invested) " +
    "or flat (in cash). Pick one action.";
  const withStrategy = state.strategy
    ? `${base} The trader has written down a strategy in state.strategy. Treat it as the trader's own ` +
      "stated preference about when to be long and when to be flat, and follow it where it applies to today's numbers."
    : base;
  return {
    type: "choice",
    instructions: withStrategy,
    criteria: {
      buy: "Go long, or stay long: the evidence favours holding the index over the next day.",
      hold: "Keep the current position unchanged, whatever it is: the evidence does not favour either side.",
      sell: "Go flat, or stay flat: the evidence favours being out of the index over the next day.",
    },
  };
}

export function marketRiskQuestion(): SystemOneScoreQuestion {
  return {
    type: "score",
    instructions:
      "How stressed does this trading day look, judged from the range, the volume and how far price " +
      "has travelled from its 20-day average?",
    criteria: [...MARKET_RISK_LEVELS],
  };
}

export type MarketDecision = {
  next: MarketReplayState;
  /** 这一步判定的那根。 */
  bar: MarketBar;
  action: MarketAction;
  /** 判定后的仓位。 */
  position: "long" | "flat";
  /** 是否换了仓（换了才收手续费）。 */
  switched: boolean;
  /** 下一根的收盘涨跌（小数，0.01 = 涨 1%）—— 这一步真正兑现的行情。 */
  ret: number;
  /** 这一步之后的净值。 */
  equity: number;
};

/**
 * 推进一步（纯函数、不可变更新）。
 *
 * `hold` 保持原仓位（包括"一直空着"），`buy` / `sell` 只在真的换边时收手续费。
 * 收益按下一根的**收盘对收盘**算：信号在今天收盘给出，持有的是明天一整天。
 */
export function applyMarketDecision(state: MarketReplayState, action: MarketAction): MarketDecision {
  const bar = state.bars[state.index] as MarketBar;
  const next = state.bars[state.index + 1];
  const position: "long" | "flat" = action === "buy" ? "long" : action === "sell" ? "flat" : state.position;
  const switched = position !== state.position;
  let equity = state.equity;
  if (switched) equity *= 1 - MARKET_FEE;
  const ret = next && bar.close > 0 ? next.close / bar.close - 1 : 0;
  if (position === "long") equity *= 1 + ret;
  const index = state.index + 1;
  return {
    next: {
      ...state,
      index,
      position,
      entry: position === "long" ? (state.position === "long" ? state.entry : bar.close) : 0,
      equity,
      trades: state.trades + (switched ? 1 : 0),
      over: index >= marketSteps(state),
    },
    bar,
    action,
    position,
    switched,
    ret,
    equity,
  };
}

export type MarketStats = {
  /** 已判定的根数。 */
  steps: number;
  /** 策略收益（百分数，4.2 = +4.2%）。 */
  returnPct: number;
  /** 同区间买入持有的收益（百分数）。 */
  benchmarkPct: number;
  trades: number;
};

/**
 * 成绩单。基准是**同一段窗口**的买入持有 —— 只报策略收益是没有意义的：
 * 一段普涨行情里闭着眼睛满仓也能赚，能说明问题的是它跟基准差多少。
 */
export function marketStats(state: MarketReplayState): MarketStats {
  const first = state.bars[0];
  // 基准只算到"最后一根被兑现的日线"，与策略净值的区间严格一致。
  const last = state.bars[Math.min(state.index, state.bars.length - 1)];
  const benchmark = first && last && first.close > 0 ? last.close / first.close - 1 : 0;
  return {
    steps: state.index,
    returnPct: round2((state.equity - 1) * 100),
    benchmarkPct: round2(benchmark * 100),
    trades: state.trades,
  };
}

// ---------------------------------------------------------------------------
// 场景 D：breakout（打砖块 —— 实时闭环）
//
// 与前三个场景的根本区别：**世界自己在动**。球每一帧都在飞，判定只在每隔
// `decideEvery` 帧发生一次 —— 一次判定要管住接下来的那几帧。这是游乐场里第一个
// "模型跟不上就真的会漏球"的场景，也是唯一一个把「判定频率」本身做成可调参数的。
//
// 一次 `advance()` = 一次判定 + 按这个动作推进 `decideEvery` 帧。帧推进是纯函数，
// 没有 requestAnimationFrame：UI 拿到的是"这一段跑完的结果 + 球在这段里的轨迹"，
// 按段画出来。真让它 60fps 地跑反而没法看 —— 一次判定几百毫秒，画面早跑没了。
//
// 落点 `predicted_x` 是我们替它算好的（照着反射一路推到板子那一行）。理由和网格
// 场景把四个方向摊开一样：encoder 类小模型不会自己做外推，与其让它猜，不如把
// "球会掉在哪"写进 state，让这道题真正考的是"要不要动、往哪动"。
// ---------------------------------------------------------------------------

export type BreakoutAction = "left" | "stay" | "right";

export const BREAKOUT_ACTIONS: readonly BreakoutAction[] = ["left", "stay", "right"];

/** 场地尺寸（用户单位，SVG 的 viewBox 直接就是它）。 */
export const BREAKOUT_W = 300;
export const BREAKOUT_H = 220;
/** 顶边（上面留一条边框线）。 */
export const BREAKOUT_TOP = 8;
export const BREAKOUT_PADDLE_W = 46;
export const BREAKOUT_PADDLE_H = 6;
export const BREAKOUT_PADDLE_Y = 194;
/** 板子每帧挪多少（一次判定管 5 帧 = 16 像素，约三分之一个板宽）。 */
export const BREAKOUT_PADDLE_SPEED = 3.2;
export const BREAKOUT_BALL_R = 3.2;

/** 砖块布局：5 行 × 8 列，行号越小分越高。 */
export const BREAKOUT_ROWS = 5;
export const BREAKOUT_COLS = 8;
const BRICK_W = 34;
const BRICK_H = 10;
const BRICK_X0 = 8;
const BRICK_Y0 = 26;
const BRICK_GAP_X = 2;
const BRICK_GAP_Y = 3;

export const BREAKOUT_LIVES = 3;

/**
 * 判定间隔的可调范围（帧）。
 *
 * 下限 2 是"几乎每帧都问"——最跟手，但一局要几百次判定；上限 12 时板子每次要
 * 瞎走 38 像素（将近一个板宽），基本接不住球了。默认 5 是两边折中。
 */
export const BREAKOUT_EVERY_MIN = 2;
export const BREAKOUT_EVERY_MAX = 12;
export const BREAKOUT_EVERY_DEFAULT = 5;

/**
 * 一局最多判定多少次。
 *
 * 和行情回放的 250 根同理：每次判定是一次 `systemoneRun`，150 次已经是"跑一次
 * 要等一分钟"的量级。到了上限就收场，按当时的分数算成绩。
 */
export const BREAKOUT_MAX_DECISIONS = 150;

export function clampBreakoutEvery(value: number): number {
  if (!Number.isFinite(value)) return BREAKOUT_EVERY_DEFAULT;
  return Math.min(BREAKOUT_EVERY_MAX, Math.max(BREAKOUT_EVERY_MIN, Math.floor(value)));
}

export type BreakoutBrick = {
  /** 左上角。 */
  x: number;
  y: number;
  row: number;
  col: number;
  /** 打掉给多少分（上面的行更值钱）。 */
  points: number;
  alive: boolean;
};

export type BreakoutBall = { x: number; y: number; vx: number; vy: number };

export type BreakoutState = {
  frame: number;
  decisions: number;
  decideEvery: number;
  ball: BreakoutBall;
  /** 板子**左边缘**。 */
  paddleX: number;
  bricks: BreakoutBrick[];
  score: number;
  lives: number;
  /** 接到球的次数 / 漏掉的次数。 */
  hits: number;
  misses: number;
  /** 全部砖块打光。 */
  cleared: boolean;
  over: boolean;
};

function buildBricks(): BreakoutBrick[] {
  const bricks: BreakoutBrick[] = [];
  for (let row = 0; row < BREAKOUT_ROWS; row++) {
    for (let col = 0; col < BREAKOUT_COLS; col++) {
      bricks.push({
        x: BRICK_X0 + col * (BRICK_W + BRICK_GAP_X),
        y: BRICK_Y0 + row * (BRICK_H + BRICK_GAP_Y),
        row,
        col,
        points: (BREAKOUT_ROWS - row) * 10,
        alive: true,
      });
    }
  }
  return bricks;
}

/**
 * 发球（纯函数、不随机）。
 *
 * 开球方向只由剩余命数决定：同一档设置跑出来永远是同一局 —— 不然"换个模型再跑
 * 一次"比的是两局不同的球路，成绩没法对照。
 */
function serve(lives: number): BreakoutBall {
  return { x: BREAKOUT_W / 2, y: 150, vx: lives % 2 === 1 ? 1.5 : -1.5, vy: -2.2 };
}

export function newBreakout(options?: { decideEvery?: number }): BreakoutState {
  const decideEvery = clampBreakoutEvery(options?.decideEvery ?? BREAKOUT_EVERY_DEFAULT);
  return {
    frame: 0,
    decisions: 0,
    decideEvery,
    ball: serve(BREAKOUT_LIVES),
    paddleX: BREAKOUT_W / 2 - BREAKOUT_PADDLE_W / 2,
    bricks: buildBricks(),
    score: 0,
    lives: BREAKOUT_LIVES,
    hits: 0,
    misses: 0,
    cleared: false,
    over: false,
  };
}

export function paddleCenter(state: BreakoutState): number {
  return state.paddleX + BREAKOUT_PADDLE_W / 2;
}

/** 板子已经贴着左 / 右墙(两边各留 2 个单位,见 `applyBreakoutAction` 的夹取)。 */
export function paddleAtLeftWall(state: BreakoutState): boolean {
  return state.paddleX <= 2.001;
}

export function paddleAtRightWall(state: BreakoutState): boolean {
  return state.paddleX >= BREAKOUT_W - BREAKOUT_PADDLE_W - 2.001;
}

export function bricksLeft(state: BreakoutState): number {
  return state.bricks.reduce((sum, brick) => sum + (brick.alive ? 1 : 0), 0);
}

/**
 * 落点预测：把球一路推到板子那一行，左右墙与天花板照常反射。
 *
 * 只算球自己的轨迹，不管板子和砖块 —— 中途打到砖会改方向，所以这是个"如果一路
 * 无阻挡"的估计。够用了：模型要的是"往左还是往右"，不是精确到像素。
 */
export function predictLanding(ball: BreakoutBall): { x: number; frames: number } {
  let { x, y, vx, vy } = ball;
  const target = BREAKOUT_PADDLE_Y - BREAKOUT_BALL_R;
  let frames = 0;
  // 上限保护：贴着水平飞的球理论上要很久才落下来，别让纯函数转到天荒地老。
  while (frames < 600 && !(y >= target && vy > 0)) {
    x += vx;
    y += vy;
    if (x < BREAKOUT_BALL_R) {
      x = BREAKOUT_BALL_R;
      vx = -vx;
    }
    if (x > BREAKOUT_W - BREAKOUT_BALL_R) {
      x = BREAKOUT_W - BREAKOUT_BALL_R;
      vx = -vx;
    }
    if (y < BREAKOUT_TOP + BREAKOUT_BALL_R) {
      y = BREAKOUT_TOP + BREAKOUT_BALL_R;
      vy = -vy;
    }
    frames++;
  }
  return { x: Math.round(x * 10) / 10, frames };
}

/** 推进一帧（纯函数）。返回新局面；`lost` 表示这一帧漏了球。 */
function stepFrame(state: BreakoutState, action: BreakoutAction): BreakoutState {
  let paddleX = state.paddleX;
  if (action === "left") paddleX -= BREAKOUT_PADDLE_SPEED;
  if (action === "right") paddleX += BREAKOUT_PADDLE_SPEED;
  paddleX = Math.min(BREAKOUT_W - BREAKOUT_PADDLE_W - 2, Math.max(2, paddleX));

  let { x, y, vx, vy } = state.ball;
  x += vx;
  y += vy;
  if (x < BREAKOUT_BALL_R) {
    x = BREAKOUT_BALL_R;
    vx = -vx;
  }
  if (x > BREAKOUT_W - BREAKOUT_BALL_R) {
    x = BREAKOUT_W - BREAKOUT_BALL_R;
    vx = -vx;
  }
  if (y < BREAKOUT_TOP + BREAKOUT_BALL_R) {
    y = BREAKOUT_TOP + BREAKOUT_BALL_R;
    vy = -vy;
  }

  // 砖块：一帧最多打掉一块（同时压到两块的边角时取先找到的那块 —— 一帧打两块
  // 会让分数跳得莫名其妙，而且两次反弹会互相抵消）。
  let bricks = state.bricks;
  let score = state.score;
  const hitIndex = bricks.findIndex(
    (brick) =>
      brick.alive &&
      x > brick.x - BREAKOUT_BALL_R &&
      x < brick.x + BRICK_W + BREAKOUT_BALL_R &&
      y > brick.y - BREAKOUT_BALL_R &&
      y < brick.y + BRICK_H + BREAKOUT_BALL_R,
  );
  if (hitIndex >= 0) {
    const brick = bricks[hitIndex] as BreakoutBrick;
    bricks = bricks.map((item, index) => (index === hitIndex ? { ...item, alive: false } : item));
    score += brick.points;
    vy = -vy;
  }

  // 板子：从上往下撞到板面才算接住（vy > 0），接球点越靠边、回球角度越斜。
  let hits = state.hits;
  if (vy > 0 && y + BREAKOUT_BALL_R >= BREAKOUT_PADDLE_Y && y - BREAKOUT_BALL_R <= BREAKOUT_PADDLE_Y + BREAKOUT_PADDLE_H) {
    if (x >= paddleX - BREAKOUT_BALL_R && x <= paddleX + BREAKOUT_PADDLE_W + BREAKOUT_BALL_R) {
      vy = -Math.abs(vy);
      y = BREAKOUT_PADDLE_Y - BREAKOUT_BALL_R;
      const offset = (x - (paddleX + BREAKOUT_PADDLE_W / 2)) / (BREAKOUT_PADDLE_W / 2);
      vx = Math.max(-2.6, Math.min(2.6, vx + offset * 0.9));
      hits += 1;
    }
  }

  let lives = state.lives;
  let misses = state.misses;
  let ball: BreakoutBall = { x, y, vx, vy };
  if (y - BREAKOUT_BALL_R > BREAKOUT_H) {
    misses += 1;
    lives -= 1;
    ball = lives > 0 ? serve(lives) : ball;
  }

  const cleared = bricks.every((brick) => !brick.alive);
  return {
    ...state,
    frame: state.frame + 1,
    ball,
    paddleX,
    bricks,
    score,
    lives,
    hits,
    misses,
    cleared,
    over: cleared || lives <= 0,
  };
}

/** 局面 → JEV 的 `state`（英文对象）。 */
export function breakoutState(state: BreakoutState): Record<string, unknown> {
  const landing = predictLanding(state.ball);
  const center = paddleCenter(state);
  const offset = Math.round((landing.x - center) * 10) / 10;
  return {
    task: "Breakout paddle control",
    description:
      "A ball bounces inside a box. A paddle at the bottom must be under the ball when it comes down, " +
      "or a life is lost. The paddle only moves left or right. This decision is held for the next " +
      `${state.decideEvery} frames, and the paddle moves ${BREAKOUT_PADDLE_SPEED} units per frame while it is held.`,
    field: { width: BREAKOUT_W, height: BREAKOUT_H, paddle_row: BREAKOUT_PADDLE_Y },
    ball: { x: Math.round(state.ball.x * 10) / 10, y: Math.round(state.ball.y * 10) / 10 },
    ball_velocity: { x: Math.round(state.ball.vx * 100) / 100, y: Math.round(state.ball.vy * 100) / 100 },
    ball_going_down: state.ball.vy > 0,
    paddle: {
      left: Math.round(state.paddleX * 10) / 10,
      center: Math.round(center * 10) / 10,
      right: Math.round((state.paddleX + BREAKOUT_PADDLE_W) * 10) / 10,
      width: BREAKOUT_PADDLE_W,
    },
    // 落点是替它算好的（见 predictLanding 的注释）。
    predicted_landing_x: landing.x,
    frames_until_landing: landing.frames,
    // 正数 = 球会落在板子右边，负数 = 落在左边。这是这道题真正的信号。
    landing_minus_paddle_center: offset,
    // 同一件事再给一个分类说法：数值比较靠的是"符号"，写成词能让 criteria 对得更实。
    landing_side: offset > BREAKOUT_PADDLE_W / 2 ? "right" : offset < -BREAKOUT_PADDLE_W / 2 ? "left" : "centred",
    // 已经贴着墙了：再往那边选就是空转一整段（模型看不见这件事就会一直顶着墙）。
    paddle_at_left_edge: paddleAtLeftWall(state),
    paddle_at_right_edge: paddleAtRightWall(state),
    // 板子这一段最多能挪多远 —— 差得比这还多，就是"追不上了"。
    paddle_reach_per_decision: Math.round(BREAKOUT_PADDLE_SPEED * state.decideEvery * 10) / 10,
    bricks_left: bricksLeft(state),
    score: state.score,
    lives: state.lives,
    decisions_made: state.decisions,
    decisions_max: BREAKOUT_MAX_DECISIONS,
  };
}

export function breakoutQuestions(state: BreakoutState): SystemOneQuestions {
  return { paddle_move: breakoutChoiceQuestion(state) };
}

/**
 * 三个选项的说明必须**各自描述一个能对上 state 的具体情形**，不能只是"往左挪 /
 * 往右挪"。
 *
 * 最初那版写的是 `Move the paddle left, up to 16 units...` 与 `Move the paddle
 * right, up to 16 units...` —— 两句话除了方向词一模一样。JEV 是给每个选项的说明
 * 打分的 encoder：说明之间没有区分度，它就只能按别的东西打破平局，于是**一整局
 * 都选同一个方向，板子顶死在墙上再也不回来**（实测就是这个样子）。
 *
 * 现在每条说明都点名 `landing_minus_paddle_center` 的符号，外加"已经贴着墙了"这件
 * 事 —— 和网格场景把每个方向"会走到哪、撞不撞墙"写进 criteria 是同一招。
 */
export function breakoutChoiceQuestion(state: BreakoutState): SystemOneChoiceQuestion {
  const reach = Math.round(BREAKOUT_PADDLE_SPEED * state.decideEvery * 10) / 10;
  const half = BREAKOUT_PADDLE_W / 2;
  return {
    type: "choice",
    instructions:
      "Which way should the paddle move for the next few frames? Put the paddle centre where the ball " +
      "will come down. The field is " +
      `${BREAKOUT_W} units wide and the paddle can travel at most ${reach} units before the next decision.`,
    criteria: {
      left:
        "The ball comes down to the LEFT of the paddle: landing_minus_paddle_center is negative, so the " +
        "paddle centre is to the right of the landing point and has to come back left. Only useful while " +
        "paddle_at_left_edge is false — at the edge the paddle cannot go any further.",
      stay:
        `The paddle is already under the landing point: landing_minus_paddle_center is within about ${half} ` +
        "units of zero, so moving either way would take the paddle off the landing point.",
      right:
        "The ball comes down to the RIGHT of the paddle: landing_minus_paddle_center is positive, so the " +
        "paddle centre is to the left of the landing point and has to move right. Only useful while " +
        "paddle_at_right_edge is false — at the edge the paddle cannot go any further.",
    },
  };
}

/**
 * 一帧的快照 —— 球**和板子**都要记。
 *
 * 一开始这里只记了球的位置，结果界面上板子只能画在"这一段跑完之后"的位置上：
 * 每隔半秒（一次判定的往返）瞬移十几像素，看着就是"板子根本没动"。动画要连续，
 * 就得有每一帧的板子在哪。
 */
export type BreakoutFrame = {
  x: number;
  y: number;
  paddleX: number;
  /** 这一帧是"漏球之后重新发球"：位置是跳过去的，中间那段不存在，别连线也别插值。 */
  served: boolean;
};

/**
 * 视觉版的请求:**不给数字,给一张图**。
 *
 * 和上面那份 `breakoutState` 是同一局面的两种问法 —— 那边把球速、落点、离板心多远
 * 全替它算好;这边只给一张当前球场的 PNG,让它自己看。两个场景并排跑,差出来的就是
 * "这个判定模型有没有视觉"。
 *
 * `state` 用的是 chat transcript 形状(`{ messages: [...] }`):协议里 `state` 允许
 * 对象,而这个形状是唯一能带 `image_url` content part 的写法。**图片只以引用形式出现**
 * (data URL 放在 `image_url` 里),不会被拼进任何文本字段 —— 拼进去就退化成几万个
 * base64 文本 token 了,那正是这个场景要避免的事。
 *
 * 纯文本的部署收到它会直接 422(拒绝而不是瞎判),这是后端该有的行为,不是这里的 bug。
 */
export function breakoutVisionState(state: BreakoutState, image: string): Record<string, unknown> {
  return {
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "This is the current frame of a Breakout game. The bricks are at the top, the " +
              "white square is the ball and the wide teal bar at the bottom is the paddle. The " +
              "fading grey dots behind the ball are where it was a moment ago, so the ball is " +
              "moving away from them; it bounces off the side walls and the top. The paddle " +
              "must be under the ball when it comes down, or a life is lost. When the paddle " +
              "already touches a side wall it cannot move any further that way. " +
              `This decision is held for the next ${state.decideEvery} frames.`,
          },
          { type: "image_url", image_url: { url: image } },
        ],
      },
    ],
  };
}

/**
 * 视觉版的问题。criteria 里**一个数字字段都不许提** —— 提了就等于把答案用文字喂回去,
 * 那就不是在考视觉了。三条说明各自描述一种"看上去是什么样"。
 *
 * 板子已经贴墙时,"往墙里推"这个选项**直接不给**:那一整段板子一动不动,本来就不是
 * 一个可选的动作。数字版靠 `paddle_at_*_edge` 让模型自己避开;视觉版试过在文字里讲
 * "贴墙推不动"、加拖尾、把图放大,35B 仍有约四分之一的步数顶着墙(最长连续 12~17 步,
 * 就是用户看到的"板子卡在边上不动")。把它从选项里拿掉之后顶墙归零,落点方向的一致率
 * 也从 38% 升到 63% —— 省下来的概率质量回到了真正可选的两个动作上。
 */
export function breakoutVisionQuestions(state: BreakoutState): SystemOneQuestions {
  const question = breakoutVisionChoice();
  const criteria = { ...question.criteria };
  if (paddleAtLeftWall(state)) delete criteria.left;
  if (paddleAtRightWall(state)) delete criteria.right;
  return { paddle_move: { ...question, criteria } };
}

function breakoutVisionChoice(): SystemOneChoiceQuestion {
  return {
    type: "choice",
    instructions:
      "Look at the picture and follow the ball's direction of travel (away from its grey trail) " +
      "down to the bottom, allowing for bounces off the side walls. Which way must the paddle " +
      "move to be under the spot where the ball will come down?",
    criteria: {
      left:
        "In the picture the ball is heading for a spot to the LEFT of the paddle, so the paddle " +
        "has to move left.",
      stay:
        "In the picture the ball is heading down onto the paddle where it already is, so the " +
        "paddle should hold still.",
      right:
        "In the picture the ball is heading for a spot to the RIGHT of the paddle, so the " +
        "paddle has to move right.",
    },
  };
}

/** 左右两项的概率差小于这个数,就算"没看出来"。 */
export const BREAKOUT_COIN_FLIP_GAP = 0.2;

/**
 * 这一步模型是不是在左右之间**掷硬币**:两个方向都在选项里,排前两名的正好是左和右,
 * 而且差距不到 `BREAKOUT_COIN_FLIP_GAP`。
 *
 * 视觉版实测(35B,150×110 的图):约一半的步数左右各 0.4~0.5,"不动"始终只有
 * 0.05~0.09 —— 它看不出球往哪飞,取最大的那个就是左一下右一下,界面上表现为板子
 * 在球下面来回抖。贴墙时只剩两个选项(其中一个是"不动"),不算。
 */
export function isBreakoutCoinFlip(probabilities: Record<string, number>): boolean {
  const left = probabilities.left;
  const right = probabilities.right;
  if (left === undefined || right === undefined) return false;
  const top = Object.entries(probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name]) => name);
  if (!top.includes("left") || !top.includes("right")) return false;
  return Math.abs(left - right) < BREAKOUT_COIN_FLIP_GAP;
}

export type BreakoutMove = {
  next: BreakoutState;
  action: BreakoutAction;
  /** 这一段里的每一帧（含起始那一帧），界面拿它逐帧播出来。 */
  frames: BreakoutFrame[];
  /** 这一段打掉几块砖、接到 / 漏掉几次。 */
  broken: number;
  caught: number;
  lost: number;
};

/**
 * 一次判定 = 推进 `decideEvery` 帧，整段都用同一个动作。
 *
 * 中途结束（漏完命 / 清屏）就提前收手，剩下的帧不跑 —— 多跑的那几帧既不该计分，
 * 画出来也是一段"已经结束之后还在动"的轨迹。
 */
export function applyBreakoutAction(state: BreakoutState, action: BreakoutAction): BreakoutMove {
  let current = state;
  const frames: BreakoutFrame[] = [
    { x: state.ball.x, y: state.ball.y, paddleX: state.paddleX, served: false },
  ];
  const before = { hits: state.hits, misses: state.misses };
  for (let i = 0; i < state.decideEvery; i++) {
    if (current.over) break;
    const previous = current;
    current = stepFrame(current, action);
    frames.push({
      x: current.ball.x,
      y: current.ball.y,
      paddleX: current.paddleX,
      // 漏球那一帧：球被挪回发球点，位置是断开的。
      served: current.misses !== previous.misses && current.lives > 0,
    });
  }
  const decisions = state.decisions + 1;
  const next: BreakoutState = {
    ...current,
    decisions,
    over: current.over || decisions >= BREAKOUT_MAX_DECISIONS,
  };
  return {
    next,
    action,
    frames,
    // 打掉几块要数砖，不能拿分数差去除以 10 —— 每行分值不同（上面那行一块就 50 分）。
    broken: bricksLeft(state) - bricksLeft(next),
    caught: next.hits - before.hits,
    lost: next.misses - before.misses,
  };
}

export type BreakoutStats = {
  score: number;
  /** 打掉的砖 / 总砖数。 */
  broken: number;
  total: number;
  lives: number;
  decisions: number;
  hits: number;
  misses: number;
};

export function breakoutStats(state: BreakoutState): BreakoutStats {
  const total = BREAKOUT_ROWS * BREAKOUT_COLS;
  return {
    score: state.score,
    broken: total - bricksLeft(state),
    total,
    lives: state.lives,
    decisions: state.decisions,
    hits: state.hits,
    misses: state.misses,
  };
}

// ---------------------------------------------------------------------------
// 统一导出
// ---------------------------------------------------------------------------

export type PlaygroundScenario = {
  id: string;
  /** i18n key（Task 3 补文案；先钉住 key 名，避免 UI 先写死字符串）。 */
  nameKey: string;
  descKey: string;
};

export const PLAYGROUND_SCENARIOS: readonly PlaygroundScenario[] = [
  {
    id: "grid-runner",
    nameKey: "jev.playground.gridRunner.name",
    descKey: "jev.playground.gridRunner.desc",
  },
  {
    id: "market-replay",
    nameKey: "jev.playground.marketReplay.name",
    descKey: "jev.playground.marketReplay.desc",
  },
  {
    id: "breakout",
    nameKey: "jev.playground.breakout.name",
    descKey: "jev.playground.breakout.desc",
  },
  {
    id: "breakout-vision",
    nameKey: "jev.playground.breakoutVision.name",
    descKey: "jev.playground.breakoutVision.desc",
  },
];
