/**
 * 场景 A 的可视化：一盘 N×N 棋盘（边长与障碍数量由左栏的盘面设置决定）。
 *
 * 整块是一张 SVG，viewBox 就是盘面本身（一格 = 一个用户单位），所以"按可用空间
 * 缩放"这件事交给 `width` 上那一行 `min(100cqw, 100cqh)` 就够了：变窄按宽缩、
 * 变矮按高缩，任何尺寸下都是完整的一整盘，不出滚动条。
 *
 * 画四样东西：走过的**路径**（一条折线，每走一步实时接长）、当前位置、终点、障碍。
 * 全部是图标而不是文字 —— 一格只有几毫米宽时，"障"字糊成一团，而一堵砖墙还认得出；
 * 文案仍留在 i18n 里，作为每个图元的无障碍名字（`<title>`）。
 *
 * 撞墙的那一步位置不变，折线上是同一个点重复 —— 画出来看不见，但步数会涨，
 * 这正是要让用户看到的代价。
 */
import type React from "react";
import { Bot, BrickWall, Flag, Home } from "lucide-react";

import { useT } from "@stores/ui-lang";
import { GRID_START, type GridRunnerState } from "./scenarios";

/** 最近一步的落点（父组件每步更新，`seq` 用来重放动画）。 */
export type GridMoveMark = {
  seq: number;
  /** 这一步想去的格子（撞边界时会落在盘外）。 */
  target: [number, number];
  /** 真的挪过去了（false = 撞墙或撞边界，位置没变但步数照计）。 */
  moved: boolean;
  inBounds: boolean;
};

/** 一格里图标的边长与左上角偏移（格子是 1×1）。 */
const ICON = 0.56;
const ICON_PAD = (1 - ICON) / 2;

/** 轨迹 → 折线上的点（去掉连续重复：撞墙那几步原地不动，画不出线段）。 */
function pathPoints(trail: readonly [number, number][]): [number, number][] {
  const points: [number, number][] = [[GRID_START[0], GRID_START[1]]];
  for (const [row, col] of trail) {
    const last = points[points.length - 1] as [number, number];
    if (last[0] === row && last[1] === col) continue;
    points.push([row, col]);
  }
  return points;
}

export function GridView({
  state,
  trail,
  lastMove,
}: {
  state: GridRunnerState;
  trail: [number, number][];
  lastMove?: GridMoveMark | null;
}) {
  const t = useT();
  const size = state.size;
  const side = "min(100cqw, 100cqh)";
  const cells = Array.from({ length: size * size }, (_, i) => [Math.floor(i / size), i % size] as const);
  const walls = new Set(state.walls.map(([r, c]) => `${r},${c}`));
  const visited = new Set(trail.map(([r, c]) => `${r},${c}`));
  const points = pathPoints(trail);
  // 线条宽度跟着盘面走：10×10 用 5×5 的线宽会把格子糊住。
  const stroke = 0.5 / size;
  // 走不通的那一步：往目标方向顶三分之一格再弹回来。
  const bump = !!lastMove && !lastMove.moved;
  const bumpX = bump ? (lastMove.target[1] - state.pos[1]) * 0.3 : 0;
  const bumpY = bump ? (lastMove.target[0] - state.pos[0]) * 0.3 : 0;

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-2">
      <div className="flex min-h-0 w-full flex-1 items-center justify-center" style={{ containerType: "size" }}>
        <svg
          viewBox={`0 0 ${size} ${size}`}
          style={{ width: side, height: side }}
          className="block overflow-visible"
          role="img"
          aria-label={t("jev.playground.grid.aria")}
        >
          {/* 底格。走过的格子留一层淡色，光看底色也能认出走过哪儿。 */}
          {cells.map(([row, col]) => {
            const key = `${row},${col}`;
            const isWall = walls.has(key);
            const isGoal = row === state.goal[0] && col === state.goal[1];
            return (
              <rect
                key={key}
                x={col + 0.04}
                y={row + 0.04}
                width={0.92}
                height={0.92}
                rx={0.12}
                className={
                  isWall
                    ? "fill-muted stroke-border"
                    : isGoal
                      ? "fill-emerald-500/15 stroke-border"
                      : visited.has(key)
                        ? "fill-primary/10 stroke-primary/40"
                        : "fill-transparent stroke-border"
                }
                strokeWidth={stroke / 2}
              />
            );
          })}

          {/* 路径：每走一步实时接长一段。只有一个点（还没动过）时不画。 */}
          {points.length > 1 ? (
            <polyline
              points={points.map(([row, col]) => `${col + 0.5},${row + 0.5}`).join(" ")}
              fill="none"
              className="stroke-primary/80"
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : null}
          {/* 路径上的落点：一步一个小圆，看得出走了几步、在哪拐的弯。 */}
          {points.slice(1, -1).map(([row, col]) => (
            <circle
              key={`dot-${row}-${col}`}
              cx={col + 0.5}
              cy={row + 0.5}
              r={stroke * 0.9}
              className="fill-primary/80"
            />
          ))}

          {/* 起点。角色站在起点上时被盖住，正好不用特意处理。 */}
          <Home
            x={GRID_START[1] + ICON_PAD}
            y={GRID_START[0] + ICON_PAD}
            width={ICON}
            height={ICON}
            className="text-muted-foreground"
            strokeWidth={2}
          >
            <title>{t("jev.playground.grid.markerStart")}</title>
          </Home>

          {state.walls.map(([row, col]) => (
            <BrickWall
              key={`wall-${row}-${col}`}
              x={col + ICON_PAD}
              y={row + ICON_PAD}
              width={ICON}
              height={ICON}
              className="text-muted-foreground"
              strokeWidth={2}
            >
              <title>{t("jev.playground.grid.markerWall")}</title>
            </BrickWall>
          ))}

          <Flag
            x={state.goal[1] + ICON_PAD}
            y={state.goal[0] + ICON_PAD}
            width={ICON}
            height={ICON}
            className="text-emerald-600"
            strokeWidth={2}
          >
            <title>{t("jev.playground.grid.markerGoal")}</title>
          </Flag>

          {/*
            撞墙那一步：位置不变，只有目标格亮一下。没有这个反馈的话，"模型连着撞
            同一堵墙"在界面上和"卡住了"一模一样 —— 而这恰恰是最常见的一种跑法。
            key 带 seq：连撞同一格时也要每步重放一次。
          */}
          {bump && lastMove?.inBounds ? (
            <rect
              key={`hit-${lastMove.seq}`}
              className="jev-grid-hit"
              x={lastMove.target[1] + 0.04}
              y={lastMove.target[0] + 0.04}
              width={0.92}
              height={0.92}
              rx={0.12}
              fill="none"
              strokeWidth={stroke}
            />
          ) : null}

          {/*
            角色。位置用 transform 而不是直接改坐标：加一段过渡之后，每一步是"滑"
            过去的 —— 一眼看得出它往哪个方向动了，而不是忽然出现在另一格。
            走不通的那一步则往目标方向顶一下再弹回来（内层 g 负责，免得和外层的
            translate 抢同一个属性）。
          */}
          <g
            style={{
              transform: `translate(${state.pos[1]}px, ${state.pos[0]}px)`,
              transition: "transform 220ms ease",
            }}
          >
            <g
              key={bump ? `bump-${lastMove?.seq}` : "still"}
              className={bump ? "jev-grid-bump" : undefined}
              style={
                bump
                  ? ({ "--jev-bump-x": `${bumpX}px`, "--jev-bump-y": `${bumpY}px` } as React.CSSProperties)
                  : undefined
              }
            >
              {/* 常驻的一圈光晕：跑起来时跟着棋子走，一眼认得出"现在在这"。 */}
              <circle cx={0.5} cy={0.5} r={0.42} className="jev-grid-halo fill-primary/30" />
              <circle cx={0.5} cy={0.5} r={0.42} className="fill-primary stroke-primary" strokeWidth={stroke / 2} />
              <Bot
                x={ICON_PAD}
                y={ICON_PAD}
                width={ICON}
                height={ICON}
                className="text-primary-foreground"
                strokeWidth={2}
              >
                <title>{t("jev.playground.grid.markerHere")}</title>
              </Bot>
            </g>
          </g>
        </svg>
      </div>

      {/* 图例用的就是盘面上那几个图元本身，不另画色块。 */}
      <div className="flex flex-none flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <Bot className="size-3" aria-hidden /> {t("jev.playground.grid.legendHere")}
        </span>
        <span className="flex items-center gap-1">
          <Flag className="size-3 text-emerald-600" aria-hidden /> {t("jev.playground.grid.legendGoal")}
        </span>
        <span className="flex items-center gap-1">
          <BrickWall className="size-3" aria-hidden /> {t("jev.playground.grid.legendWall")}
        </span>
        <span className="flex items-center gap-1">
          <svg className="size-3" viewBox="0 0 12 12" aria-hidden>
            <polyline points="1,9 5,9 5,3 11,3" fill="none" className="stroke-primary" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {t("jev.playground.grid.legendTrail")}
        </span>
      </div>
    </div>
  );
}
