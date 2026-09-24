import { describe, expect, test } from "bun:test";
import { FRAME_H, FRAME_SCALE, FRAME_W, paintBreakout, type Painter } from "./breakout-frame";
import { newBreakout, type BreakoutState } from "./scenarios";

type Rect = { color: string; x: number; y: number; w: number; h: number };

function record(state: BreakoutState): Rect[] {
  const rects: Rect[] = [];
  let color = "";
  const ctx: Painter = {
    get fillStyle() {
      return color;
    },
    set fillStyle(value: unknown) {
      color = String(value);
    },
    fillRect: (x, y, w, h) => rects.push({ color, x, y, w, h }),
  };
  paintBreakout(ctx, state);
  return rects;
}

const BALL = "#F1EFE8";
const TRAIL = ["#8C8A84", "#5E5D59", "#403F3D"];

describe("breakout-frame：给模型看的那张图", () => {
  test("球身后有三个越来越暗的点，落在速度的反方向上；球最后画", () => {
    const game = newBreakout({ decideEvery: 5 });
    const state: BreakoutState = { ...game, ball: { x: 150, y: 120, vx: 2, vy: 2 } };
    const rects = record(state);
    const ball = rects[rects.length - 1]!;
    expect(ball.color).toBe(BALL);
    const trail = rects.filter((rect) => TRAIL.includes(rect.color));
    expect(trail.map((rect) => rect.color)).toEqual([...TRAIL].reverse()); // 远的先画
    // 球往右下走，拖尾就都在左上方，且越远越偏
    for (const dot of trail) {
      expect(dot.x).toBeLessThan(ball.x);
      expect(dot.y).toBeLessThan(ball.y);
    }
    expect(trail[0]!.x).toBeLessThan(trail[2]!.x);
  });

  test("拖尾点出了场地就不画（刚从墙上弹回来时），其余照画，且都在画面内", () => {
    const game = newBreakout({ decideEvery: 5 });
    // 贴着左墙往右飞：往回推会推到墙外
    const state: BreakoutState = { ...game, ball: { x: 6, y: 120, vx: 1, vy: -1 } };
    const rects = record(state);
    const trail = rects.filter((rect) => TRAIL.includes(rect.color));
    expect(trail.length).toBeLessThan(3);
    for (const rect of rects) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.w).toBeLessThanOrEqual(FRAME_W);
      expect(rect.y + rect.h).toBeLessThanOrEqual(FRAME_H);
    }
  });

  test("图仍在 200×200 以内", () => {
    expect(FRAME_W).toBeLessThanOrEqual(200);
    expect(FRAME_H).toBeLessThanOrEqual(200);
    expect(FRAME_SCALE).toBe(0.5);
  });
});
