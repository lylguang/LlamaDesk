import { test, expect } from "bun:test";

import { FOLLOW_THRESHOLD_PX, isFollowing } from "./use-follow-scroll";

const at = (distanceFromBottom: number) => ({
  scrollHeight: 1000,
  clientHeight: 300,
  scrollTop: 1000 - 300 - distanceFromBottom,
});

test("isFollowing 判据是严格小于阈值（FOLLOW_THRESHOLD_PX = 64）", () => {
  expect(FOLLOW_THRESHOLD_PX).toBe(64);
  expect(isFollowing(at(FOLLOW_THRESHOLD_PX))).toBe(false);
});

test("正好贴底（scrollTop + clientHeight === scrollHeight）→ 跟随", () => {
  expect(isFollowing(at(0))).toBe(true);
});

test("距底 63 像素（阈值内）→ 跟随", () => {
  expect(isFollowing(at(63))).toBe(true);
});

test("距底 64 像素（正好等于阈值）→ 不跟随（判据是严格小于）", () => {
  expect(isFollowing(at(FOLLOW_THRESHOLD_PX))).toBe(false);
});

test("距底很远（500 像素）→ 不跟随", () => {
  expect(isFollowing(at(500))).toBe(false);
});

test("内容不足一屏（scrollHeight === clientHeight）→ 跟随", () => {
  expect(isFollowing({ scrollHeight: 300, clientHeight: 300, scrollTop: 0 })).toBe(true);
});
