/**
 * JEV 页（左侧一级菜单，默认排在 Agent 与通话之间）。
 *
 * 布局照抄语音合成页那一套（用户明确要求对齐）：**左栏是参数、右栏是产物**。
 * 左栏顶部是「判定引擎」的分段切换（本地运行 / 云端接入），下面是该引擎的配置、
 * 要判断的 state、问题清单与运行按钮；右栏是概率分布结果，没跑之前是空态。
 * 示例清单在应用侧栏（`sidebar.tsx`），点一下装进左侧编辑器。
 *
 * 为什么引擎切换放在这一页而不是"设置 → 模型"：这里要连的是**判定模型**（laya-mlx 的
 * 开放权重 / TypeSafe），它不是聊天模型，选它和选聊天模型是两个问题；而且本页要能
 * 直接"装引擎 → 下权重 → 启动 → 立刻试"，跳出去配就断了这条链。
 */
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SlidersHorizontalIcon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { useJevStore } from "@stores/jev";
import { useJevMetrics } from "@stores/jev-metrics";
import { useT } from "@stores/ui-lang";
import { useQuery } from "@tanstack/react-query";
import { JevAnswers, type JevRunResult } from "./answers";
import { EngineSelector } from "./engine-panel";
import { NaturalLanguageBox } from "./nl-box";
import { JevPlayground } from "./playground";
import { QuestionEditor } from "./questions";
import { buildCallExample, buildQuestions } from "./drafts";

/**
 * 侧栏顶部的两段切换：判定台（`JevConsole`）/ 游乐场（`JevPlayground`）。
 * 分叉必须在这一层：判定台自己有一批 hook，若在它内部按 view 提前 return，
 * 切到游乐场的那次渲染就会少跑一批 hook（Rendered fewer hooks than expected）。
 */
export function JevScreen() {
  const view = useJevStore((s) => s.view);
  return view === "playground" ? <JevPlayground /> : <JevConsole />;
}

function JevConsole() {
  const t = useT();
  const queryClient = useQueryClient();
  // 状态放 store：侧栏点示例要改这里正在编辑的草稿，两处隔着 MainLayout 的层级。
  const state = useJevStore((s) => s.state);
  const setState = useJevStore((s) => s.setState);
  const drafts = useJevStore((s) => s.drafts);
  const setDrafts = useJevStore((s) => s.setDrafts);
  const model = useJevStore((s) => s.model);
  const setModel = useJevStore((s) => s.setModel);
  const applyDraft = useJevStore((s) => s.applyDraft);
  const [result, setResult] = useState<JevRunResult | undefined>(undefined);
  const [copied, setCopied] = useState(false);

  const status = useQuery({
    queryKey: ["systemone", "status"],
    queryFn: () => rpcClient.systemoneStatus(undefined),
  });

  const built = useMemo(() => buildQuestions(drafts), [drafts]);
  const example = useMemo(() => buildCallExample(state, built.questions), [state, built.questions]);

  const run = useMutation({
    mutationFn: async (override?: { state: string; questions: Record<string, unknown> }) => {
      // 计时放在这里而不是后端：驾驶舱要的是"点下运行到看见答案"的端到端耗时。
      const started = performance.now();
      const result = await rpcClient.systemoneRun({
        // 生成路径要把"刚生成的那一份"立刻发出去（此刻 store 还没重新渲染完）。
        state: override?.state ?? state,
        questions: override?.questions ?? built.questions,
        ...(model.trim() ? { model: model.trim() } : {}),
      });
      useJevMetrics.getState().record({
        at: Date.now(),
        ms: Math.round(performance.now() - started),
        ok: result.ok,
        backend: result.ok ? result.backend : null,
        source: "console",
      });
      return result;
    },
    onSuccess: (data) => {
      setResult(data);
      // 每次调用都记一行用量（价格 0，只记 tokens 与次数），用完刷新账本。
      void queryClient.invalidateQueries({ queryKey: ["usage"] });
    },
  });

  return (
    <div className="flex h-full min-h-0 flex-1">
      {/* 左：引擎 + 参数（宽度与语音页的参数列一致） */}
      <section className="flex w-[380px] min-w-[340px] flex-none flex-col gap-4 overflow-y-auto border-r p-4">
        <div className="flex items-center gap-2">
          <SlidersHorizontalIcon className="size-4 text-muted-foreground" aria-hidden />
          <h1 className="text-sm font-semibold">{t("jev.title")}</h1>
          <span className="ml-auto flex items-center gap-1">
            {status.data?.resolved ? (
              <span className="jev-pill ok">{t(`systemone.backend.${status.data.resolved}`)}</span>
            ) : (
              <span className="jev-pill warn">{t("systemone.backend.none")}</span>
            )}
            <span className="jev-pill free">{t("systemone.free")}</span>
          </span>
        </div>

        <EngineSelector />

        {/*
         * 「用一句话生成请求」在引擎配置之下、手动编辑器之上：它是入门路径，
         * 而引擎是配一次就不用再动的设置。生成结果会填进下面的编辑器（可改）。
         */}
        <NaturalLanguageBox
          onDrafted={({ state: draftedState, drafts: draftedDrafts, questions }) => {
            applyDraft({ state: draftedState, drafts: draftedDrafts });
            // 生成完直接跑一次：用户要的是结果，不是先看一眼请求体再点一次按钮。
            run.mutate({ state: draftedState, questions });
          }}
        />

        <div className="border-t pt-3">
          <QuestionEditor
            state={state}
            onState={setState}
            drafts={drafts}
            onDrafts={setDrafts}
            model={model}
            onModel={setModel}
            problems={built.problems}
            running={run.isPending}
            canRun={Object.keys(built.questions).length > 0}
            onRun={() => run.mutate(undefined)}
          />
        </div>
      </section>

      {/* 右：结果 */}
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden p-5">
        <JevAnswers
          result={result}
          example={example}
          copied={copied}
          onCopy={(text) => {
            void navigator.clipboard?.writeText(text).catch(() => {});
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        />
      </section>
    </div>
  );
}
