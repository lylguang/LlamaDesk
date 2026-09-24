/**
 * 控制列的下半部分：要判断的 state + 问题清单 + 模型 + 运行按钮。
 *
 * 控制列比结果区窄（对齐语音合成页：参数在左、产物在右），所以问题卡是**竖排**的：
 * 名字与类型一行、instructions 一行、criteria 按其形状展开 —— 窄列里横排会挤成一团。
 * "形状自解释"仍然保留：选 noul 出现 yes/no 两个框，choice 出现「标签 / 适用情形」行，
 * score 出现带档位号的排序列表。
 */
import { Loader2Icon, PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { useT } from "@stores/ui-lang";
import { Button } from "@ui/button";
import { Textarea } from "@ui/textarea";
import { cn } from "@/mainview/lib/utils";
import {
  newQuestionDraft,
  uniqueQuestionName,
  type DraftProblem,
  type QuestionDraft,
  type SystemOneQuestionTypeName,
} from "./drafts";

const TYPES: SystemOneQuestionTypeName[] = ["noul", "choice", "score"];
const INPUT = "w-full min-w-0 rounded-lg border bg-transparent px-2.5 py-1.5 text-xs outline-none focus-visible:border-ring";

export function QuestionEditor({
  state,
  onState,
  drafts,
  onDrafts,
  model,
  onModel,
  problems,
  running,
  canRun,
  onRun,
}: {
  state: string;
  onState: (value: string) => void;
  drafts: QuestionDraft[];
  onDrafts: (next: QuestionDraft[]) => void;
  model: string;
  onModel: (value: string) => void;
  problems: DraftProblem[];
  running: boolean;
  canRun: boolean;
  onRun: () => void;
}) {
  const t = useT();
  const patch = (id: string, next: Partial<QuestionDraft>) =>
    onDrafts(drafts.map((draft) => (draft.id === id ? { ...draft, ...next } : draft)));

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-semibold text-muted-foreground">{t("jev.state")}</span>
      <Textarea
        value={state}
        rows={5}
        spellCheck={false}
        placeholder={t("jev.statePlaceholder")}
        onChange={(event) => onState(event.target.value)}
      />

      <div className="mt-1 flex items-center gap-2">
        <span className="text-xs font-semibold text-muted-foreground">{t("jev.questions")}</span>
        <span className="ml-auto flex gap-1">
          {TYPES.map((type) => (
            <Button
              key={type}
              size="sm"
              variant="outline"
              className="gap-1 px-2"
              onClick={() => onDrafts([...drafts, newQuestionDraft(uniqueQuestionName(drafts, type), type)])}
            >
              <PlusIcon size={11} aria-hidden />
              <span className="text-[11px]">{t(`jev.type.${type}`)}</span>
            </Button>
          ))}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        {drafts.map((draft) => (
          <QuestionCard
            key={draft.id}
            draft={draft}
            onChange={(next) => patch(draft.id, next)}
            onRemove={() => onDrafts(drafts.filter((item) => item.id !== draft.id))}
          />
        ))}
      </div>

      {problems.length > 0 ? (
        <p className="jev-note error">
          {problems
            .map((problem) =>
              problem.kind === "duplicate"
                ? t("jev.error.duplicate", { name: problem.name })
                : t("jev.error.emptyName"),
            )
            .join(" ")}
        </p>
      ) : null}

      <label className="mt-1 flex flex-col gap-1">
        <span className="text-[11px] text-muted-foreground">{t("jev.model")}</span>
        <input
          className={cn(INPUT, "font-mono")}
          value={model}
          spellCheck={false}
          placeholder={t("jev.modelPlaceholder")}
          onChange={(event) => onModel(event.target.value)}
        />
      </label>

      <Button size="sm" className="mt-1 w-full gap-1.5" disabled={running || !canRun} onClick={onRun}>
        {running ? <Loader2Icon size={12} className="animate-spin" aria-hidden /> : <PlayIcon size={12} aria-hidden />}
        {t("jev.run")}
      </Button>
    </div>
  );
}

function QuestionCard({
  draft,
  onChange,
  onRemove,
}: {
  draft: QuestionDraft;
  onChange: (next: Partial<QuestionDraft>) => void;
  onRemove: () => void;
}) {
  const t = useT();
  return (
    <div className="rounded-lg border bg-card p-2.5">
      <div className="flex items-center gap-1.5">
        <input
          className={cn(INPUT, "flex-1 font-mono font-semibold")}
          value={draft.name}
          spellCheck={false}
          aria-label={t("jev.questionName")}
          onChange={(event) => onChange({ name: event.target.value })}
        />
        <select
          className={cn(INPUT, "w-28 flex-none text-[11px]")}
          value={draft.type}
          aria-label={t("jev.type")}
          onChange={(event) => {
            const type = event.target.value as SystemOneQuestionTypeName;
            const fresh = newQuestionDraft(draft.name, type);
            // 换类型时 criteria 的形状变了，旧值不再有意义 → 重置成该类型的默认骨架。
            onChange({ type, options: fresh.options, levels: fresh.levels, trueDesc: "", falseDesc: "" });
          }}
        >
          <option value="noul">{t("jev.type.noul")}</option>
          <option value="choice">{t("jev.type.choice")}</option>
          <option value="score">{t("jev.type.score")}</option>
        </select>
        <button type="button" className="wp-action-btn flex-none" aria-label={t("jev.removeQuestion")} onClick={onRemove}>
          <Trash2Icon size={13} aria-hidden />
        </button>
      </div>

      <input
        className={cn(INPUT, "mt-1.5")}
        value={draft.instructions}
        spellCheck={false}
        placeholder={t("jev.instructionsPlaceholder")}
        onChange={(event) => onChange({ instructions: event.target.value })}
      />

      {draft.type === "noul" ? (
        <div className="mt-1.5 flex flex-col gap-1.5">
          <input
            className={INPUT}
            value={draft.trueDesc}
            placeholder={t("jev.trueDesc")}
            onChange={(event) => onChange({ trueDesc: event.target.value })}
          />
          <input
            className={INPUT}
            value={draft.falseDesc}
            placeholder={t("jev.falseDesc")}
            onChange={(event) => onChange({ falseDesc: event.target.value })}
          />
        </div>
      ) : null}

      {draft.type === "choice" ? (
        <div className="mt-1.5 flex flex-col gap-1.5">
          {draft.options.map((option, index) => (
            <div key={index} className="flex items-center gap-1.5">
              <input
                className={cn(INPUT, "w-24 flex-none font-mono")}
                value={option.label}
                placeholder={t("jev.optionLabel")}
                onChange={(event) => {
                  const options = [...draft.options];
                  options[index] = { ...option, label: event.target.value };
                  onChange({ options });
                }}
              />
              <input
                className={cn(INPUT, "flex-1")}
                value={option.desc}
                placeholder={t("jev.optionDesc")}
                onChange={(event) => {
                  const options = [...draft.options];
                  options[index] = { ...option, desc: event.target.value };
                  onChange({ options });
                }}
              />
              <button
                type="button"
                className="wp-action-btn flex-none"
                aria-label={t("jev.removeOption")}
                onClick={() => onChange({ options: draft.options.filter((_, i) => i !== index) })}
              >
                <Trash2Icon size={12} aria-hidden />
              </button>
            </div>
          ))}
          <Button
            size="sm"
            variant="outline"
            className="gap-1 self-start"
            onClick={() => onChange({ options: [...draft.options, { label: "", desc: "" }] })}
          >
            <PlusIcon size={11} aria-hidden />
            <span className="text-[11px]">{t("jev.addOption")}</span>
          </Button>
        </div>
      ) : null}

      {draft.type === "score" ? (
        <div className="mt-1.5 flex flex-col gap-1.5">
          {draft.levels.map((level, index) => (
            <div key={index} className="flex items-center gap-1.5">
              <span className="w-3 flex-none text-right font-mono text-[11px] text-muted-foreground">{index}</span>
              <input
                className={cn(INPUT, "flex-1")}
                value={level}
                placeholder={t("jev.levelPlaceholder")}
                onChange={(event) => {
                  const levels = [...draft.levels];
                  levels[index] = event.target.value;
                  onChange({ levels });
                }}
              />
              <button
                type="button"
                className="wp-action-btn flex-none"
                aria-label={t("jev.removeLevel")}
                onClick={() => onChange({ levels: draft.levels.filter((_, i) => i !== index) })}
              >
                <Trash2Icon size={12} aria-hidden />
              </button>
            </div>
          ))}
          <Button
            size="sm"
            variant="outline"
            className="gap-1 self-start"
            onClick={() => onChange({ levels: [...draft.levels, ""] })}
          >
            <PlusIcon size={11} aria-hidden />
            <span className="text-[11px]">{t("jev.addLevel")}</span>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
