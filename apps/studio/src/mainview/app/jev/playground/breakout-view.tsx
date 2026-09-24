/**
 * 场景 D 的可视化：一台打砖块。
 *
 * 画面按街机那套来 —— 深色场地、五排彩砖、板子和球，顶上一行 SCORE / 命数 /
 * 剩余砖块。场地用固定的深色而不是主题色：这是一块游戏屏幕，亮色主题下也该是
 * 深的（砖块那五个经典颜色在浅底上根本分不出层次）。
 *
 * **动画是逐帧播出来的**。一次判定推进若干帧，两次判定之间隔着一个网络往返 —— 如果
 * 只在判定回来时画一次，板子就是每隔半秒瞬移十几像素（看着像"板子根本没动"），球
 * 也是一跳一跳的。所以这里拿到的是这一段的**每一帧**（球 + 板子），用 rAF 在两次
 * 判定之间把它们匀速播完，帧与帧之间线性插值 —— 每帧本来就是匀速直线运动的采样点，
 * 插值出来就是真实轨迹，不是凭空脑补的。
 *
 * 漏球之后重新发球那一帧（`served`）**不插值也不连线**：球是被挪回发球点的，中间
 * 那段路根本不存在，插出来就成了一条横穿球场的假轨迹（之前看着就像"贴着底线跳帧"）。
 *
 * 那条虚线是**我们替模型算好的落点**（`predictLanding`），画出来是为了让人能当场
 * 判断模型这一步该不该动、动对了没有。
 */
import { useEffect, useRef, useState } from "react";

import { useT } from "@stores/ui-lang";
import { FRAME_H, FRAME_W } from "./breakout-frame";
import {
  breakoutStats,
  bricksLeft,
  paddleCenter,
  predictLanding,
  BREAKOUT_BALL_R,
  BREAKOUT_H,
  BREAKOUT_MAX_DECISIONS,
  BREAKOUT_PADDLE_H,
  BREAKOUT_PADDLE_W,
  BREAKOUT_PADDLE_Y,
  BREAKOUT_TOP,
  BREAKOUT_W,
  type BreakoutFrame,
  type BreakoutState,
} from "./scenarios";

/** 五排砖的经典配色（行号 → 颜色），深底上分得开。 */
const ROW_COLORS = ["#E24B4A", "#EF9F27", "#FAC775", "#97C459", "#85B7EB"];
const FIELD_BG = "#17171a";
const FIELD_LINE = "#3a3a40";
const BALL_COLOR = "#F1EFE8";
const PADDLE_COLOR = "#9FE1CB";

const BRICK_W = 34;
const BRICK_H = 10;

/**
 * 一段帧播多久。
 *
 * 一个判定周期大约是"一次 RPC（两三百毫秒）+ 步间停顿 260ms"，播放略短于它：
 * 播完刚好接上下一段，既不会播到一半被打断，也不会停太久显得卡。
 */
const SEGMENT_PLAY_MS = 420;

/** 播放头（0..1）落在哪两帧之间，插出当前的球与板子。 */
function sampleFrames(frames: readonly BreakoutFrame[], play: number) {
  const last = frames.length - 1;
  const at = Math.max(0, Math.min(last, play * last));
  const i = Math.min(last, Math.floor(at));
  const a = frames[i] as BreakoutFrame;
  const b = (frames[i + 1] ?? a) as BreakoutFrame;
  const f = at - i;
  // 发球那一帧是传送：插值会画出一条穿过整个球场的假轨迹，所以直接跳过去。
  if (b.served) return f < 1 ? a : b;
  return {
    x: a.x + (b.x - a.x) * f,
    y: a.y + (b.y - a.y) * f,
    paddleX: a.paddleX + (b.paddleX - a.paddleX) * f,
    served: false,
  };
}

/** 已经播到的那一段轨迹，按"发球"切成互不相连的几段。 */
function trailPaths(frames: readonly BreakoutFrame[], play: number): string[] {
  const last = frames.length - 1;
  const upto = Math.max(0, Math.min(last, Math.floor(play * last)));
  const paths: string[] = [];
  let current: string[] = [];
  for (let i = 0; i <= upto; i++) {
    const frame = frames[i] as BreakoutFrame;
    if (frame.served) {
      if (current.length > 1) paths.push(current.join(" "));
      current = [];
    }
    current.push(`${frame.x.toFixed(1)},${frame.y.toFixed(1)}`);
  }
  if (current.length > 1) paths.push(current.join(" "));
  return paths;
}

export function BreakoutView({
  state,
  frames,
  picture,
}: {
  state: BreakoutState;
  frames: BreakoutFrame[];
  /** 视觉版:模型这一步真正看到的那张图。给了就直接放大显示它,不再画 SVG。 */
  picture?: string | null;
}) {
  const t = useT();
  const stats = breakoutStats(state);
  const landing = predictLanding(state.ball);
  const center = paddleCenter(state);

  // 播放头：每来一段新的帧就从 0 重播一次。
  const [play, setPlay] = useState(1);
  const rafRef = useRef(0);
  useEffect(() => {
    if (frames.length < 2) {
      setPlay(1);
      return;
    }
    const started = performance.now();
    setPlay(0);
    const tick = (now: number) => {
      const progress = Math.min(1, (now - started) / SEGMENT_PLAY_MS);
      setPlay(progress);
      if (progress < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [frames]);

  // 还没跑过（或只有一帧）时就画局面本身。
  const shown =
    frames.length >= 2
      ? sampleFrames(frames, play)
      : { x: state.ball.x, y: state.ball.y, paddleX: state.paddleX, served: false };
  const paths = frames.length >= 2 ? trailPaths(frames, play) : [];

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-2">
      {/* HUD。等宽字体 + 心形命数，和街机上那一行对齐。 */}
      <div className="flex flex-none flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
        <span>
          {t("jev.playground.breakout.score")} {String(stats.score).padStart(4, "0")}
        </span>
        <span aria-label={t("jev.playground.breakout.lives")}>
          {stats.lives > 0 ? "♥".repeat(stats.lives) : "—"}
        </span>
        <span>
          {t("jev.playground.breakout.bricks")} {stats.broken}/{stats.total}
        </span>
        <span>
          {t("jev.playground.breakout.catches")} {stats.hits}/{stats.hits + stats.misses}
        </span>
        <span className="ml-auto">
          {t("jev.playground.breakout.decisions", {
            n: String(stats.decisions),
            max: String(BREAKOUT_MAX_DECISIONS),
          })}
        </span>
      </div>

      {picture ? (
        /*
          视觉版:**把发给模型的那张 PNG 原样放大**,而不是另画一张好看的。
          人看到的和模型看到的必须是同一份像素 —— 另画一张,演示就成了障眼法。
          `pixelated` 关掉插值:150×110 的图放大几倍,糊成一片就看不出是像素风了。
        */
        <div className="flex min-h-0 w-full flex-1 items-start justify-center">
          <img
            src={picture}
            alt={t("jev.playground.breakout.aria")}
            className="block h-auto w-full max-w-full rounded"
            style={{ imageRendering: "pixelated", aspectRatio: `${BREAKOUT_W} / ${BREAKOUT_H}` }}
          />
        </div>
      ) : (
      <div className="flex min-h-0 w-full flex-1 items-start justify-center" style={{ containerType: "size" }}>
        <svg
          viewBox={`0 0 ${BREAKOUT_W} ${BREAKOUT_H}`}
          style={{ width: `min(100cqw, ${(BREAKOUT_W / BREAKOUT_H).toFixed(3)} * 100cqh)` }}
          className="block"
          role="img"
          aria-label={t("jev.playground.breakout.aria")}
        >
          <rect x={0} y={0} width={BREAKOUT_W} height={BREAKOUT_H} rx={4} fill={FIELD_BG} />
          <line x1={0} y1={BREAKOUT_TOP} x2={BREAKOUT_W} y2={BREAKOUT_TOP} stroke={FIELD_LINE} strokeWidth={1} />

          {state.bricks.map((brick) =>
            brick.alive ? (
              <g key={`${brick.row}-${brick.col}`}>
                <rect x={brick.x} y={brick.y} width={BRICK_W} height={BRICK_H} rx={1.5} fill={ROW_COLORS[brick.row] ?? "#B4B2A9"} />
                {/* 顶上一条高光：砖块看起来才像"块"，而不是色带。 */}
                <rect x={brick.x} y={brick.y} width={BRICK_W} height={2.4} rx={1.2} fill="rgba(255,255,255,0.22)" />
              </g>
            ) : null,
          )}

          {/* 落点预测：一条竖虚线 + 板子那一行的小三角。 */}
          <line
            x1={landing.x}
            y1={BREAKOUT_TOP}
            x2={landing.x}
            y2={BREAKOUT_PADDLE_Y}
            stroke="#378ADD"
            strokeWidth={0.8}
            strokeDasharray="3 3"
            opacity={0.65}
          />
          <polygon
            points={`${landing.x - 3},${BREAKOUT_PADDLE_Y + 10} ${landing.x + 3},${BREAKOUT_PADDLE_Y + 10} ${landing.x},${BREAKOUT_PADDLE_Y + 4}`}
            fill="#378ADD"
            opacity={0.8}
          />

          {/* 已经播到的球迹（每帧一个点连成线，发球处断开）。 */}
          {paths.map((points, index) => (
            <polyline
              key={index}
              points={points}
              fill="none"
              stroke={BALL_COLOR}
              strokeWidth={1.2}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={0.35}
            />
          ))}

          {/* 方块而不是圆:与视觉版那张像素图一个观感(那边 3.2 个单位缩完只有 1.6 像素,
              画圆会糊成一团灰)。两个场景看起来得是同一台街机。 */}
          <rect
            x={shown.x - BREAKOUT_BALL_R}
            y={shown.y - BREAKOUT_BALL_R}
            width={BREAKOUT_BALL_R * 2}
            height={BREAKOUT_BALL_R * 2}
            fill={BALL_COLOR}
          />

          <g>
            <rect x={shown.paddleX} y={BREAKOUT_PADDLE_Y} width={BREAKOUT_PADDLE_W} height={BREAKOUT_PADDLE_H} rx={3} fill={PADDLE_COLOR} />
            <rect x={shown.paddleX} y={BREAKOUT_PADDLE_Y} width={BREAKOUT_PADDLE_W} height={2} rx={1} fill="rgba(255,255,255,0.35)" />
          </g>

          {state.over ? (
            <g>
              <rect x={0} y={BREAKOUT_H / 2 - 16} width={BREAKOUT_W} height={32} fill="rgba(0,0,0,0.55)" />
              <text
                x={BREAKOUT_W / 2}
                y={BREAKOUT_H / 2 + 5}
                textAnchor="middle"
                fill={BALL_COLOR}
                style={{ fontSize: 13, fontFamily: "monospace", letterSpacing: 2 }}
              >
                {state.cleared ? t("jev.playground.breakout.cleared") : t("jev.playground.breakout.gameOver")}
              </text>
            </g>
          ) : null}
        </svg>
      </div>
      )}

      {picture ? (
        <p className="flex-none text-[10px] leading-4 text-muted-foreground">
          {t("jev.playground.breakoutVision.legend", { w: String(FRAME_W), h: String(FRAME_H) })}
        </p>
      ) : (
      <div className="flex flex-none flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <svg className="size-3" viewBox="0 0 12 12" aria-hidden>
            <line x1="6" y1="1" x2="6" y2="11" stroke="#378ADD" strokeWidth="1.5" strokeDasharray="2 2" />
          </svg>
          {t("jev.playground.breakout.legendLanding")}
        </span>
        <span>
          {t("jev.playground.breakout.legendOffset", {
            value: (Math.round((landing.x - center) * 10) / 10).toFixed(1),
          })}
        </span>
        <span>{t("jev.playground.breakout.legendTrail")}</span>
        <span>
          {t("jev.playground.breakout.legendLeft", { n: String(bricksLeft(state)) })}
        </span>
      </div>
      )}
    </div>
  );
}
