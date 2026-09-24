/**
 * 侧栏底部的「数据驾驶舱」：这套配置**刚刚真的跑出来**的延迟。
 *
 * 形式是照着"这组数要回答什么"选的：最先要知道的是"上一次多久"，那是一个数字，
 * 所以用大字打头，不画图；后面才是趋势（一次一根的细柱）与三个概览数字。单序列，
 * 所以没有图例；数字一律用文本色，颜色只留给柱子本身。
 *
 * P95 单列出来是因为平均值会把偶发的那几次慢请求抹平 —— 而判定是一步一调用的，
 * 一次 2 秒的卡顿在游乐场里就是肉眼可见的一顿。
 */
import { Trash2Icon } from "lucide-react";

import { useT } from "@stores/ui-lang";
import { summarize, useJevMetrics } from "@stores/jev-metrics";
import { Button } from "@ui/button";

/** 趋势里最多画这么多根：再多在侧栏宽度里就细成一片了。 */
const SPARK_BARS = 24;

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <span className="font-mono text-[11px]">{value}</span>
    </div>
  );
}

export function JevMetricsPanel() {
  const t = useT();
  const samples = useJevMetrics((s) => s.samples);
  const clear = useJevMetrics((s) => s.clear);
  const stats = summarize(samples);
  const recent = samples.slice(-SPARK_BARS);
  const peak = Math.max(1, ...recent.filter((s) => s.ok).map((s) => s.ms));

  return (
    <div className="flex flex-none flex-col gap-1.5 border-t px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold text-muted-foreground">{t("jev.metrics.title")}</span>
        {samples.length > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto size-5 p-0"
            title={t("jev.metrics.clear")}
            aria-label={t("jev.metrics.clear")}
            onClick={clear}
          >
            <Trash2Icon className="size-3" aria-hidden />
          </Button>
        ) : null}
      </div>

      {stats.last === null ? (
        <p className="text-[10px] leading-4 text-muted-foreground">{t("jev.metrics.empty")}</p>
      ) : (
        <>
          {/* 头条数字：上一次判定花了多久。 */}
          <div className="flex items-baseline gap-1">
            <span className="font-mono text-lg leading-none">{stats.last}</span>
            <span className="text-[10px] text-muted-foreground">{t("jev.metrics.lastMs")}</span>
          </div>

          {/* 趋势：一次一根，按最慢的一次归一化。失败的那次画成整根的警示色。 */}
          <svg
            viewBox={`0 0 ${SPARK_BARS * 3} 24`}
            preserveAspectRatio="none"
            className="h-7 w-full"
            role="img"
            aria-label={t("jev.metrics.sparkAria", { n: String(recent.length) })}
          >
            {recent.map((sample, index) => {
              const height = sample.ok ? Math.max(1.5, (sample.ms / peak) * 22) : 22;
              return (
                <rect
                  key={`${sample.at}-${index}`}
                  x={index * 3}
                  y={24 - height}
                  width={2}
                  height={height}
                  rx={0.8}
                  className={sample.ok ? "fill-primary/70" : "fill-destructive/60"}
                >
                  <title>
                    {sample.ok
                      ? t("jev.metrics.barTip", { ms: String(sample.ms) })
                      : t("jev.metrics.barFailed")}
                  </title>
                </rect>
              );
            })}
          </svg>

          <Stat label={t("jev.metrics.average")} value={`${stats.average} ms`} />
          <Stat label={t("jev.metrics.p95")} value={`${stats.p95} ms`} />
          <Stat label={t("jev.metrics.range")} value={`${stats.fastest}–${stats.slowest} ms`} />
          <Stat
            label={t("jev.metrics.count")}
            value={
              stats.failed > 0
                ? t("jev.metrics.countWithFailed", { n: String(stats.count), failed: String(stats.failed) })
                : t("jev.metrics.countValue", { n: String(stats.count) })
            }
          />
        </>
      )}
    </div>
  );
}
