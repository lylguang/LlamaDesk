/**
 * 场景 C 的可视化：一段日 K + 成交量 + 每根上的判定标记。
 *
 * 整块是一张 SVG，宽度铺满、按 `viewBox` 等比缩放 —— 和棋盘一样，"多大都完整"
 * 比"能滚动"重要：回放窗口最多 250 根，挤是挤了点，但一眼能看完整段行情。
 *
 * 颜色按**中文市场习惯**：红涨绿跌（三个标的里两个是 A 股 / 港股）。上半是 K 线，
 * 下半是成交量柱 —— 成交量各市场口径不同（见 `market-data.ts`），所以柱子只按
 * "本窗口内的最大量"归一化，纵轴不标任何绝对数字。
 *
 * 判定标记画在 K 线的上下方：buy 在下、sell 在上（顺着"低买高卖"的直觉），
 * hold 是一小段横线。标记大小跟着置信度走 —— 模型犹豫的那几天点会明显小一圈。
 */
import { useT } from "@stores/ui-lang";
import { MARKET_META, type MarketBar } from "./market-data";
import { marketStats, type MarketAction, type MarketReplayState } from "./scenarios";

/** 一步判定的结果（界面只留画图要用的那几项）。 */
export type MarketMark = {
  /** 在回放窗口里的下标。 */
  index: number;
  action: MarketAction;
  /** 0..1。 */
  confidence: number;
  /** 风险档位 0..3；没答上来时是 null。 */
  risk: number | null;
};

const W = 420;
const PAD = 8;
const PRICE_TOP = 12;
const PRICE_BOTTOM = 148;
const VOL_TOP = 162;
const VOL_BOTTOM = 204;
const H = 212;

export function MarketView({ state, marks }: { state: MarketReplayState; marks: MarketMark[] }) {
  const t = useT();
  const bars = state.bars;
  const meta = MARKET_META[state.symbol];
  const stats = marketStats(state);

  if (bars.length < 2) {
    return <div className="jev-note error">{t("jev.playground.market.rangeTooShort")}</div>;
  }

  const step = (W - PAD * 2) / bars.length;
  let low = Infinity;
  let high = -Infinity;
  let maxVolume = 0;
  for (const bar of bars) {
    if (bar.low < low) low = bar.low;
    if (bar.high > high) high = bar.high;
    if (bar.volume > maxVolume) maxVolume = bar.volume;
  }
  // 上下各留一成余量：贴着边框的最高点与最低点很难看出"到顶了"。
  const margin = (high - low) * 0.1 || 1;
  low -= margin;
  high += margin;
  const y = (price: number) => PRICE_BOTTOM - ((price - low) / (high - low)) * (PRICE_BOTTOM - PRICE_TOP);
  const bodyWidth = Math.max(0.8, step * 0.6);
  const markByIndex = new Map(marks.map((mark) => [mark.index, mark]));

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-2">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block w-full flex-none"
        role="img"
        aria-label={t("jev.playground.market.aria")}
      >
        {/* 价格区的四条横向参考线（不标数字：这里要看的是形状与相对位置）。 */}
        {[0, 1, 2, 3].map((i) => {
          const gy = PRICE_TOP + ((PRICE_BOTTOM - PRICE_TOP) * i) / 3;
          return <line key={i} x1={PAD} y1={gy} x2={W - PAD} y2={gy} className="stroke-border" strokeWidth={0.4} />;
        })}

        {/* 当前这根：一条竖着的淡色带 —— 日志里那一步说的就是它。 */}
        {!state.over ? (
          <rect
            x={PAD + step * state.index}
            y={PRICE_TOP - 6}
            width={step}
            height={VOL_BOTTOM - PRICE_TOP + 8}
            className="fill-primary/10"
            rx={1}
          />
        ) : null}

        {bars.map((bar, i) => {
          const x = PAD + step * i + step / 2;
          const up = bar.close >= bar.open;
          // 红涨绿跌。
          const tone = up ? "fill-rose-500 stroke-rose-500" : "fill-emerald-600 stroke-emerald-600";
          const top = y(Math.max(bar.open, bar.close));
          const height = Math.max(0.8, Math.abs(y(bar.open) - y(bar.close)));
          const volumeHeight = maxVolume > 0 ? (bar.volume / maxVolume) * (VOL_BOTTOM - VOL_TOP) : 0;
          return (
            <g key={bar.date} className={tone}>
              <title>{barTitle(bar)}</title>
              <line x1={x} y1={y(bar.high)} x2={x} y2={y(bar.low)} strokeWidth={0.6} />
              <rect x={x - bodyWidth / 2} y={top} width={bodyWidth} height={height} stroke="none" />
              <rect
                x={x - bodyWidth / 2}
                y={VOL_BOTTOM - volumeHeight}
                width={bodyWidth}
                height={volumeHeight}
                stroke="none"
                opacity={0.45}
              />
            </g>
          );
        })}

        {/* 判定标记。放在 K 线之后画，保证盖在柱子上面。 */}
        {bars.map((bar, i) => {
          const mark = markByIndex.get(i);
          if (!mark) return null;
          const x = PAD + step * i + step / 2;
          const radius = 1.4 + Math.max(0, Math.min(1, mark.confidence)) * 2.6;
          if (mark.action === "buy") {
            return <circle key={`m-${i}`} cx={x} cy={y(bar.low) + 6} r={radius} className="fill-rose-500" opacity={0.85} />;
          }
          if (mark.action === "sell") {
            return <circle key={`m-${i}`} cx={x} cy={y(bar.high) - 6} r={radius} className="fill-emerald-600" opacity={0.85} />;
          }
          return (
            <rect key={`m-${i}`} x={x - 2} y={y(bar.low) + 5} width={4} height={1.4} rx={0.7} className="fill-muted-foreground" />
          );
        })}

        <text x={PAD} y={VOL_TOP - 4} className="fill-muted-foreground" style={{ fontSize: 7 }}>
          {t("jev.playground.market.volumeAxis")}
        </text>
        <text x={W - PAD} y={PRICE_TOP - 4} textAnchor="end" className="fill-muted-foreground" style={{ fontSize: 7 }}>
          {`${meta.name} · ${meta.currency}`}
        </text>
      </svg>

      {/* 成绩：策略 vs 买入持有。只报策略收益没意义 —— 普涨行情里满仓也赚。 */}
      {/* 窄栏里四格会挤成一团（900px 窗口下右栏只剩两百来像素）：按**这一栏自己的
          宽度**折成两行，而不是按窗口宽度 —— 左栏是固定的 380px，窗口断点说明不了
          右栏还剩多少。 */}
      <div className="@container flex-none">
        <div className="grid grid-cols-2 gap-2 @[420px]:grid-cols-4">
          <Metric label={t("jev.playground.market.position")} value={t(`jev.playground.market.position.${state.position}`)} />
          <Metric
            label={t("jev.playground.market.return")}
            value={percent(stats.returnPct)}
            tone={stats.returnPct >= 0 ? "up" : "down"}
          />
          <Metric
            label={t("jev.playground.market.benchmark")}
            value={percent(stats.benchmarkPct)}
            tone={stats.benchmarkPct >= 0 ? "up" : "down"}
          />
          <Metric label={t("jev.playground.market.trades")} value={String(stats.trades)} />
        </div>
      </div>

      <div className="flex flex-none flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="inline-block size-2 rounded-full bg-rose-500" aria-hidden /> {t("jev.playground.market.legendBuy")}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block size-2 rounded-full bg-emerald-600" aria-hidden /> {t("jev.playground.market.legendSell")}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-0.5 w-2 rounded bg-muted-foreground" aria-hidden /> {t("jev.playground.market.legendHold")}
        </span>
        <span>{t("jev.playground.market.legendSize")}</span>
      </div>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return (
    <div className="rounded-md bg-chip px-2 py-1.5">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p
        className={
          tone === "up" ? "text-sm font-semibold text-rose-500" : tone === "down" ? "text-sm font-semibold text-emerald-600" : "text-sm font-semibold"
        }
      >
        {value}
      </p>
    </div>
  );
}

function percent(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

/** 悬停提示：一根日线的四个价格（日期在最前面，方便对着图找日子）。 */
function barTitle(bar: MarketBar): string {
  return `${bar.date}  O ${bar.open}  H ${bar.high}  L ${bar.low}  C ${bar.close}`;
}
