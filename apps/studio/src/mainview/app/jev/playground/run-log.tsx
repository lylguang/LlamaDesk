/**
 * 运行日志：每步一行。
 *
 * 一行 = 一次 `systemoneRun`：步号、问题名、模型的选择、置信度、概率分布条
 *（画法与 `../answers.tsx` 的 `ProbabilityBar` 一致，但那个文件是判定台的
 * 组件，不能为了游乐场动它）、以及这一步的耗时（调用前后各取一次
 * `performance.now()`，差值取整）。
 */
import { useEffect, useRef } from "react";

import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";

/** 一步运行的记录（父组件在调用前后各取一次时间戳算出 ms）。 */
export type RunLogEntry = {
  /** 1 起。 */
  step: number;
  /** 问题名（如 `next_move` / `queue` / `urgent`）。 */
  question: string;
  /** choice → 选项名；noul → "true" / "false"。 */
  choice: string;
  /** 0..1；noul 没有单独的 confidence（noul 本身即置信度），此时 undefined。 */
  confidence?: number;
  /** 该问题的概率分布（noul 是 { true, false }）。 */
  probabilities: Record<string, number>;
  /** 本步耗时（ms）。 */
  ms: number;
};

function ProbabilityBar({ label, value }: { label: string; value: number }) {
  const percent = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className={cn("jev-prob")}>
      <span className="jev-prob-label" title={label}>
        {label}
      </span>
      <span className="jev-prob-track">
        <span className="jev-prob-fill" style={{ width: `${percent}%` }} />
      </span>
      <span className="jev-prob-value">{percent.toFixed(1)}%</span>
    </div>
  );
}

export function RunLog({ entries }: { entries: RunLogEntry[] }) {
  const t = useT();
  const boxRef = useRef<HTMLDivElement>(null);
  /**
   * 是否"粘"在最新一条上。
   *
   * 网格 / 工单那会儿一局最多十几条，日志停在顶上也看得见；打砖块一局能有一百多条，
   * 不自动跟到底部的话，跑起来之后看到的永远是第 1 步 —— 等于这块面板白摆。
   * 但用户往回翻的时候不能把他拽回去，所以只在"本来就贴着底"时才跟。
   */
  const stickRef = useRef(true);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    // 重置（条目清零）之后回到跟随状态，否则下一局会停在用户上次翻到的地方。
    if (entries.length === 0) {
      stickRef.current = true;
      return;
    }
    if (stickRef.current) box.scrollTop = box.scrollHeight;
  }, [entries.length]);

  if (entries.length === 0) {
    return <p className="px-1 text-[11px] text-muted-foreground">{t("jev.playground.log.empty")}</p>;
  }
  return (
    // 只允许竖向滚：右栏窄的时候，横向滚动条会把本来就矮的日志区又吃掉一条，
    // 而且要横拖才看得全一行 —— 抬头那一行改成可换行，窄栏里自己折下去。
    <div
      ref={boxRef}
      // 离底部 24px 以内就算"贴着底"：滚动条的小数误差和刚好差半行都别算成"用户翻走了"。
      onScroll={(event) => {
        const box = event.currentTarget;
        stickRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
      }}
      className="flex min-h-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto pb-2"
    >
      {entries.map((entry) => {
        const probs = Object.entries(entry.probabilities).sort((a, b) => b[1] - a[1]);
        return (
          // 一步可能产生两条（工单那一步 queue + urgent 同号），key 要带上问题名。
          <div key={`${entry.step}-${entry.question}`} className="jev-card flex-none">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="flex-none font-mono text-[10px] text-muted-foreground">
                {t("jev.playground.log.step", { n: String(entry.step) })}
              </span>
              <span className="jev-answer-name">{entry.question}</span>
              <span className="jev-answer-headline">{entry.choice}</span>
              <span className="flex-none text-[10px] text-muted-foreground">
                {entry.confidence !== undefined
                  ? `${t("jev.playground.log.confidence", { value: entry.confidence.toFixed(3) })}`
                  : ""}
                {" · "}
                {entry.ms} ms
              </span>
            </div>
            <div className="jev-probs">
              {probs.map(([label, value]) => (
                <ProbabilityBar key={label} label={label} value={value} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
