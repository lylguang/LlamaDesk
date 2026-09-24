/**
 * JEV 的侧栏：顶部是「判定台 / 游乐场」两段切换。
 *
 *   - 判定台（原有行为）：内置示例清单（对齐语音页侧栏的位置 —— 那边是记录列表，
 *     这里是示例）。示例解决"面对一堆 noul / choice / score 输入框，我该问什么"的门槛。
 *   - 游乐场：列出 `PLAYGROUND_SCENARIOS`（Task 1 的纯逻辑场景），点一下只记录
 *     选中（`scenarioId`）并把 `view` 切过去 —— 跑与停是主体左栏的按钮的事，
 *     侧栏不触发运行。
 *
 * 为什么用示例而不是记录：判定结果不适合当"历史记录"（同一段文本跑两次的答案一样，
 * 存下来只是一堆重复的概率分布）。
 */
import { LightbulbIcon, PlayIcon, RotateCcwIcon } from "lucide-react";

import { useJevStore } from "@stores/jev";
import { useT, useUILang } from "@stores/ui-lang";
import { Button } from "@ui/button";
import { cn } from "@/mainview/lib/utils";
import { jevExamples } from "./examples";
import { JevMetricsPanel } from "./metrics-panel";
import { JevModelPicker } from "./model-picker";
import { PLAYGROUND_SCENARIOS } from "./playground/scenarios";

export function JevSidebar() {
  const t = useT();
  const lang = useUILang((s) => s.lang);
  const view = useJevStore((s) => s.view);
  const setView = useJevStore((s) => s.setView);
  const exampleId = useJevStore((s) => s.exampleId);
  const applyExample = useJevStore((s) => s.applyExample);
  const reset = useJevStore((s) => s.reset);
  const scenarioId = useJevStore((s) => s.scenarioId);
  const setScenarioId = useJevStore((s) => s.setScenarioId);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 最上面先回答"现在用的是哪个模型" —— 两个 view 看的都是它跑出来的结果。 */}
      <JevModelPicker />

      {/* 两段切换：两个 view 的入口都摆在这里，而不是藏在主区。 */}
      <div className="flex flex-none gap-1 px-2 pt-2">
        {(
          [
            ["console", t("jev.playground.view.console")],
            ["playground", t("jev.playground.view.playground")],
          ] as const
        ).map(([id, label]) => (
          <Button
            key={id}
            size="sm"
            variant={view === id ? "default" : "ghost"}
            className="h-6 flex-1 gap-1 px-1.5"
            onClick={() => setView(id)}
          >
            {id === "playground" ? <PlayIcon size={3} aria-hidden /> : <LightbulbIcon size={3} aria-hidden />}
            <span className="text-[11px]">{label}</span>
          </Button>
        ))}
      </div>

      {view === "console" ? (
        <>
          <div className="flex items-center gap-2 px-3 py-2.5">
            <LightbulbIcon className="size-3.5 text-muted-foreground" aria-hidden />
            <span className="text-xs font-semibold">{t("jev.examples")}</span>
            <Button size="sm" variant="ghost" className="ml-auto h-6 gap-1 px-1.5" onClick={reset}>
              <RotateCcwIcon className="size-3" aria-hidden />
              <span className="text-[11px]">{t("jev.examples.reset")}</span>
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            <div className="flex flex-col gap-1">
              {jevExamples(lang).map((example) => (
                <button
                  key={example.id}
                  type="button"
                  className={cn(
                    "flex flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                    exampleId === example.id ? "bg-accent/60" : "hover:bg-accent/40",
                  )}
                  onClick={() => applyExample(example.id)}
                >
                  <span className="text-xs font-medium">{t(example.nameKey)}</span>
                  <span className="text-[10px] leading-4 text-muted-foreground">{t(example.descKey)}</span>
                </button>
              ))}
            </div>
            <p className="px-2.5 pt-3 text-[10px] leading-4 text-muted-foreground">{t("jev.examples.hint")}</p>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2 px-3 py-2.5">
            <PlayIcon className="size-3.5 text-muted-foreground" aria-hidden />
            <span className="text-xs font-semibold">{t("jev.playground.scenarios")}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            <div className="flex flex-col gap-1">
              {PLAYGROUND_SCENARIOS.map((scenario) => (
                <button
                  key={scenario.id}
                  type="button"
                  className={cn(
                    "flex flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                    scenarioId === scenario.id ? "bg-accent/60" : "hover:bg-accent/40",
                  )}
                  onClick={() => {
                    setScenarioId(scenario.id);
                    setView("playground");
                  }}
                >
                  <span className="text-xs font-medium">{t(scenario.nameKey)}</span>
                  <span className="text-[10px] leading-4 text-muted-foreground">{t(scenario.descKey)}</span>
                </button>
              ))}
            </div>
            <p className="px-2.5 pt-3 text-[10px] leading-4 text-muted-foreground">
              {t("jev.playground.hint")}
            </p>
          </div>
        </>
      )}

      {/* 最下面是刚刚跑出来的延迟：换模型之后快了还是慢了，一眼看得到。 */}
      <JevMetricsPanel />
    </div>
  );
}
