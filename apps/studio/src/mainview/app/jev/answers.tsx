/**
 * 右栏：结果区（对齐语音合成页 —— 空态居中一个图标 + 一句话，出结果后换成内容）。
 *
 * 呈现重点**不是**"选中了什么"，而是**概率分布**：`choice` 只看第一名会丢掉
 * "0.51 还是 0.99"这个最关键的信息，而 `score` 的期望值本来就允许落在两档之间。
 * 所以每种答案都画成分布条，`confidence` 单独一行 —— 它的用法是设阈值分流。
 */
import { ChevronDownIcon, ChevronRightIcon, CopyIcon, ListChecksIcon, SparklesIcon } from "lucide-react";
import { useState } from "react";

import { useT } from "@stores/ui-lang";
import { Button } from "@ui/button";
import { cn } from "@/mainview/lib/utils";
import type { SystemOneAnswer, SystemOneResponse } from "../../../shared/systemone";

/** RPC 的返回：成功带 response/backend，失败带状态码与官方错误体。 */
export type JevRunResult =
  | { ok: true; response: SystemOneResponse; backend: string; requestId: string }
  | { ok: false; status: number; body: unknown; message: string; backend: string | null };

export function JevAnswers({
  result,
  example,
  copied,
  onCopy,
}: {
  result: JevRunResult | undefined;
  example: string;
  copied: boolean;
  onCopy: (text: string) => void;
}) {
  const t = useT();
  const response = result?.ok ? result.response : null;
  const failure = result && !result.ok ? result : null;

  if (!response && !failure) {
    // 空态：与语音合成页同一套（居中图标 + 一句"产物会出现在这里"）。
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-muted">
          <ListChecksIcon className="size-6 text-muted-foreground" aria-hidden />
        </span>
        <p className="text-sm font-medium">{t("jev.answers")}</p>
        <p className="max-w-sm text-[11px] leading-5 text-muted-foreground">{t("jev.empty")}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-muted-foreground">{t("jev.answers")}</span>
        <Button size="sm" variant="outline" className="ml-auto gap-1.5" onClick={() => onCopy(example)}>
          <CopyIcon size={12} aria-hidden />
          {copied ? t("jev.copied") : t("jev.copyExample")}
        </Button>
      </div>

      {failure ? (
        <div className="jev-note error mt-3">
          <strong>{t("jev.failed", { status: String(failure.status) })}</strong>
          <div>{failure.message}</div>
          {failure.backend === null ? <div>{t("jev.failed.hint")}</div> : null}
        </div>
      ) : null}

      {response ? (
        <>
          <div className="jev-results-head mt-3">
            <span className="jev-pill ok">{response.model}</span>
            {result?.ok ? <span className="jev-pill">{t(`systemone.backend.${result.backend}`)}</span> : null}
            <span className="jev-pill free">{t("systemone.free")}</span>
            <span className="jev-status-note">
              {t("jev.usage", {
                input: String(response.usage.input_tokens),
                output: String(response.usage.output_tokens),
              })}
            </span>
          </div>
          <div className="mt-3 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-2">
            {Object.entries(response.answers).map(([name, answer]) => (
              <AnswerCard key={name} name={name} answer={answer} />
            ))}
          </div>
        </>
      ) : null}

      <details className="mt-3 flex-none">
        <summary className="cursor-pointer text-xs text-muted-foreground">{t("jev.example.title")}</summary>
        <pre className="jev-code mt-2 max-h-96">{example}</pre>
      </details>

      <p className="jev-footnote mt-3 flex-none">
        <SparklesIcon size={12} aria-hidden /> {t("jev.footnote")}
      </p>
    </div>
  );
}

function AnswerCard({ name, answer }: { name: string; answer: SystemOneAnswer }) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const headline =
    answer.type === "noul" ? answer.noul.toFixed(4) : answer.type === "choice" ? answer.choice : answer.score.toFixed(2);

  return (
    <div className="jev-card answer">
      <button type="button" className="jev-card-head" onClick={() => setOpen((value) => !value)}>
        {open ? <ChevronDownIcon size={13} aria-hidden /> : <ChevronRightIcon size={13} aria-hidden />}
        <span className="jev-answer-name">{name}</span>
        <span className="jev-type-badge">{t(`jev.type.${answer.type}`)}</span>
        <span className="jev-answer-headline">{headline}</span>
      </button>
      {open ? (
        <div className="jev-answer-body">
          {answer.type === "noul" ? (
            <ProbabilityBar label="P(true)" value={answer.noul} />
          ) : (
            <>
              <span className="jev-answer-meta">
                {t("jev.confidence", { value: answer.confidence.toFixed(4) })}
              </span>
              <ProbabilityList
                probabilities={answer.probabilities}
                {...(answer.type === "score" ? { legend: answer.legend } : {})}
              />
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ProbabilityList({
  probabilities,
  legend,
}: {
  probabilities: Record<string, number>;
  legend?: Record<string, unknown>;
}) {
  const entries = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
  return (
    <div className="jev-probs">
      {entries.map(([key, value]) => (
        <ProbabilityBar
          key={key}
          label={legend?.[key] === undefined ? key : `${key} · ${describeCriterion(legend[key])}`}
          value={value}
        />
      ))}
    </div>
  );
}

/** legend 的描述可能是字符串，也可能是结构化 criteria（对象 / 数组）——统一成一行短文本。 */
function describeCriterion(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

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
