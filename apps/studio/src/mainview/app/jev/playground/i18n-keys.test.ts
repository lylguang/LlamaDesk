/**
 * 游乐场的 i18n 守卫：这份清单 = 游乐场 UI（`index.tsx` / `grid-view.tsx` /
 * `market-view.tsx` / `breakout-view.tsx` / `run-log.tsx` / `../sidebar.tsx`）实际
 * 用到的**全部** key，以及 `scenarios.ts` 钉住的那几个场景的 name / desc。
 *
 * 三条断言：
 *   1. key 无重复，且全部以 `jev.playground.` 开头（防止有人随手用别的前缀）；
 *   2. 每个 key 在 `zh` 与 `en` 两个字典里都存在且非空（缺一个、或只翻了一半
 *      —— 界面会回退成英文 / key 原文 —— 都算红）；
 *   3. 占位符与调用处一致（代码按调用签名拼参数，多传的参数会被 `translate`
 *      忽略 —— 所以字典里漏掉一个占位符不会崩，只会把界面写成
 *      `第 {n} / 20 步` 这样的半成品，这里按每个调用处实际传的参数名钉死）。
 */
import { expect, test } from "bun:test";

import { translate } from "../../../../shared/i18n";
import { PLAYGROUND_SCENARIOS } from "./scenarios";

/** `playground/index.tsx` + 三个场景的 view + `run-log.tsx` + `../sidebar.tsx` 用到的全部 key。 */
const PLAYGROUND_UI_KEYS = [
  // 侧栏切换
  "jev.playground.view.console",
  "jev.playground.view.playground",
  "jev.playground.scenarios",
  "jev.playground.hint",
  // 场景元数据（scenarios.ts 的 nameKey / descKey）
  ...PLAYGROUND_SCENARIOS.flatMap((scenario) => [scenario.nameKey, scenario.descKey]),
  // 未选场景空态
  "jev.playground.empty",
  "jev.playground.empty.hint",
  // 后端状态
  "jev.playground.backend.notReady",
  // 运行控制
  "jev.playground.start",
  "jev.playground.step",
  "jev.playground.reset",
  "jev.playground.progress",
  "jev.playground.done",
  // 右栏标题 / 进度
  "jev.playground.grid.steps",
  "jev.playground.log.title",
  // 棋盘
  "jev.playground.grid.aria",
  "jev.playground.grid.markerHere",
  "jev.playground.grid.markerGoal",
  "jev.playground.grid.markerWall",
  "jev.playground.grid.markerStart",
  "jev.playground.grid.legendHere",
  "jev.playground.grid.legendGoal",
  "jev.playground.grid.legendWall",
  "jev.playground.grid.legendTrail",
  // 行情回放
  "jev.playground.market.symbol.shc",
  "jev.playground.market.symbol.hsi",
  "jev.playground.market.symbol.spx",
  "jev.playground.market.settings",
  "jev.playground.market.from",
  "jev.playground.market.to",
  "jev.playground.market.rangeHint",
  "jev.playground.market.rangeHintTruncated",
  "jev.playground.market.strategy",
  "jev.playground.market.strategyPlaceholder",
  "jev.playground.market.strategyOn",
  "jev.playground.market.strategyOff",
  "jev.playground.market.disclaimer",
  "jev.playground.market.progress",
  "jev.playground.market.aria",
  "jev.playground.market.volumeAxis",
  "jev.playground.market.rangeTooShort",
  "jev.playground.market.position",
  "jev.playground.market.position.long",
  "jev.playground.market.position.flat",
  "jev.playground.market.return",
  "jev.playground.market.benchmark",
  "jev.playground.market.trades",
  "jev.playground.market.legendBuy",
  "jev.playground.market.legendSell",
  "jev.playground.market.legendHold",
  "jev.playground.market.legendSize",
  // 打砖块
  "jev.playground.breakout.settings",
  "jev.playground.breakout.every",
  "jev.playground.breakout.everyValue",
  "jev.playground.breakout.settingsHint",
  "jev.playground.breakout.progress",
  "jev.playground.breakout.score",
  "jev.playground.breakout.lives",
  "jev.playground.breakout.bricks",
  "jev.playground.breakout.catches",
  "jev.playground.breakout.decisions",
  "jev.playground.breakout.aria",
  "jev.playground.breakout.cleared",
  "jev.playground.breakout.gameOver",
  "jev.playground.breakout.legendLanding",
  "jev.playground.breakout.legendOffset",
  "jev.playground.breakout.legendTrail",
  "jev.playground.breakout.legendLeft",
  "jev.playground.breakout.noSignal",
  "jev.playground.breakoutVision.noCanvas",
  "jev.playground.breakoutVision.hint",
  "jev.playground.breakoutVision.legend",
  "jev.playground.breakoutVision.noSignal",
  // 运行日志
  "jev.playground.log.empty",
  "jev.playground.log.step",
  "jev.playground.log.confidence",
];

/**
 * key → 各调用处实际传入的占位符名（取自代码里 `t(key, { … })` 的参数名）。
 * 只列有插值的 key；没有的传 `{}` 即可（断言里跳过）。
 */
const PLACEHOLDERS: Record<string, string[][]> = {
  "jev.playground.progress": [["n", "total"]],
  "jev.playground.grid.steps": [["n", "max"]],
  "jev.playground.log.step": [["n"]],
  "jev.playground.market.progress": [["done", "total"]],
  "jev.playground.market.rangeHint": [["bars", "steps", "first", "last"]],
  "jev.playground.market.rangeHintTruncated": [["bars", "available", "max"]],
  "jev.playground.breakout.everyValue": [["n"]],
  "jev.playground.breakout.settingsHint": [["reach", "max"]],
  "jev.playground.breakout.progress": [["score", "lives"]],
  "jev.playground.breakout.decisions": [["n", "max"]],
  "jev.playground.breakout.legendOffset": [["value"]],
  "jev.playground.breakout.legendLeft": [["n"]],
  "jev.playground.breakoutVision.legend": [["w", "h"]],
  "jev.playground.breakout.noSignal": [["wasted", "steps", "confidence"]],
  "jev.playground.breakoutVision.noSignal": [["flips", "steps"]],
  "jev.playground.log.confidence": [["value"]],
};

const SAMPLE_VALUES: Record<string, string> = {
  n: "3",
  total: "8",
  max: "20",
  done: "5",
  confidence: "80%",
  value: "0.902",
  bars: "60",
  steps: "59",
  first: "2019-01-02",
  last: "2026-09-21",
  available: "300",
  reach: "16.0",
  w: "150",
  h: "110",
  wasted: "9",
  flips: "11",
  score: "120",
  lives: "2",
};

test("游乐场用到的 i18n key 无重复，且全部以 jev.playground. 开头", () => {
  expect(new Set(PLAYGROUND_UI_KEYS).size).toBe(PLAYGROUND_UI_KEYS.length);
  for (const key of PLAYGROUND_UI_KEYS) {
    expect(key.startsWith("jev.playground."), `key 前缀不对: ${key}`).toBe(true);
  }
});

test("游乐场用到的 i18n key 在 zh 与 en 两个字典里都存在且非空", () => {
  const missing: string[] = [];
  for (const key of PLAYGROUND_UI_KEYS) {
    for (const lang of ["zh", "en"] as const) {
      // `translate` 缺词条时回退成 key 本身（回退链 zh → en → key）；
      // 这里对两种情况（回退、空串）一起判，任何一处缺文案都会列出来。
      const text = translate(lang, key);
      if (!text || text === key) missing.push(`${lang}:${key}`);
    }
  }
  expect(missing).toEqual([]);
});

test("游乐场词条的插值占位符与调用处一致（翻译后不残留 {…}）", () => {
  const bad: string[] = [];
  for (const [key, paramSets] of Object.entries(PLACEHOLDERS)) {
    for (const params of paramSets) {
      for (const lang of ["zh", "en"] as const) {
        const values = Object.fromEntries(params.map((name) => [name, SAMPLE_VALUES[name] ?? "x"]));
        const text = translate(lang, key, values);
        for (const name of params) {
          if (!text.includes(values[name]!)) bad.push(`${lang}:${key} 缺占位符 {${name}} → "${text}"`);
        }
      }
    }
  }
  expect(bad).toEqual([]);
});
