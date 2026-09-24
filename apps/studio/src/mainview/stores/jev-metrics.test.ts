/**
 * 驾驶舱的统计口径。
 *
 * 这里每一条都对应界面上的一个数字，写死是为了它们别悄悄换意思：平均值不能被
 * 失败那次的 0 ms 拉低，P95 在样本少时就取最慢的一次（不插值 —— 不给一个谁都
 * 没跑出来过的数），"调用次数"算上失败的那几次。
 */
import { expect, test } from "bun:test";

import { summarize, useJevMetrics, type JevSample } from "./jev-metrics";

function sample(ms: number, ok = true): JevSample {
  return { at: Date.now(), ms, ok, backend: ok ? "cloud" : null, source: "playground" };
}

test("没有样本时每个数字都是空，不是 0", () => {
  const stats = summarize([]);
  expect(stats).toEqual({ count: 0, failed: 0, last: null, average: null, p95: null, fastest: null, slowest: null });
});

test("平均 / 最快 / 最慢 只看成功的那几次", () => {
  // 失败那次是 0 ms（请求就没发出去），算进平均会把 200 ms 的手感说成 150 ms。
  const stats = summarize([sample(100), sample(200), sample(300), sample(0, false)]);
  expect(stats.count).toBe(4);
  expect(stats.failed).toBe(1);
  expect(stats.average).toBe(200);
  expect(stats.fastest).toBe(100);
  expect(stats.slowest).toBe(300);
  expect(stats.last).toBe(300);
});

test("P95：样本少时就是最慢的一次，多了才真的是第 95 百分位", () => {
  expect(summarize([sample(100), sample(900)]).p95).toBe(900);
  const many = Array.from({ length: 20 }, (_, i) => sample((i + 1) * 10));
  // 20 个样本：第 19 个（190 ms）是 95 分位，最慢的 200 ms 不算。
  expect(summarize(many).p95).toBe(190);
});

test("只留最近 50 次：换过模型的旧样本不该混进当前手感", () => {
  const store = useJevMetrics.getState();
  store.clear();
  for (let i = 0; i < 60; i++) useJevMetrics.getState().record(sample(i + 1));
  const kept = useJevMetrics.getState().samples;
  expect(kept).toHaveLength(50);
  expect(kept[0]?.ms).toBe(11);
  expect(kept[kept.length - 1]?.ms).toBe(60);
  useJevMetrics.getState().clear();
  expect(useJevMetrics.getState().samples).toHaveLength(0);
});
