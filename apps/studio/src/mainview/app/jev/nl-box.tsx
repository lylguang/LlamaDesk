/**
 * 「用一句话生成请求」：自然语言的入口，放在编辑器的上方。
 *
 * 为什么在手动编辑器**之上**而不是取代它：写请求体（三原语 + criteria 形状）是这页最陡的
 * 门槛，多数人只想说"帮我按这三条给简历打分"；但生成结果未必一次到位，所以生成的草稿照常
 * 填进下面的编辑器，用户可以改完再跑 —— AI 生成 + 人手改，两条路都在。
 *
 * 用的是当前配置的**聊天模型**（不是 JEV 后端）：它只负责"把人话翻成请求体"，
 * 真正判定由下面的「运行」按当前引擎（本地 / 云端）发出，两者是两件事。
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2Icon, SparklesIcon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { useT } from "@stores/ui-lang";
import { Button } from "@ui/button";
import { Textarea } from "@ui/textarea";
import type { SystemOneQuestions } from "../../../shared/systemone";
import { draftFromQuestions, type QuestionDraft } from "./drafts";

export function NaturalLanguageBox({
  onDrafted,
}: {
  /** 生成的请求体交给页面：填进编辑器（可改）并直接跑一次。 */
  onDrafted: (payload: { state: string; drafts: QuestionDraft[]; questions: SystemOneQuestions; modelUsed: string }) => void;
}) {
  const t = useT();
  const [instruction, setInstruction] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const generate = useMutation({
    mutationFn: () => rpcClient.systemoneDraft({ instruction, text }),
    onSuccess: (result) => {
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      onDrafted({
        state: result.state,
        drafts: draftFromQuestions(result.questions),
        questions: result.questions,
        modelUsed: result.modelUsed,
      });
      setInstruction("");
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  return (
    <div className="rounded-lg border bg-card p-2.5">
      <div className="flex items-center gap-1.5">
        <SparklesIcon className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="text-xs font-semibold">{t("jev.nl.title")}</span>
      </div>
      <p className="mt-1 text-[10px] leading-4 text-muted-foreground">{t("jev.nl.hint")}</p>

      <Textarea
        className="mt-2"
        value={instruction}
        rows={2}
        spellCheck={false}
        placeholder={t("jev.nl.instructionPlaceholder")}
        onChange={(event) => setInstruction(event.target.value)}
      />
      <Textarea
        className="mt-1.5"
        value={text}
        rows={3}
        spellCheck={false}
        placeholder={t("jev.nl.textPlaceholder")}
        onChange={(event) => setText(event.target.value)}
      />

      <Button
        size="sm"
        className="mt-2 w-full gap-1.5"
        // 只有一句话也行（内容可以后补），但两栏全空时不值得花一次推理。
        disabled={generate.isPending || (!instruction.trim() && !text.trim())}
        onClick={() => generate.mutate()}
      >
        {generate.isPending ? (
          <Loader2Icon className="size-3 animate-spin" aria-hidden />
        ) : (
          <SparklesIcon className="size-3" aria-hidden />
        )}
        {generate.isPending ? t("jev.nl.generating") : t("jev.nl.generate")}
      </Button>

      {error ? <p className="jev-note error mt-2">{error}</p> : null}
      {generate.data?.ok ? (
        <p className="jev-note ok mt-2">{t("jev.nl.generated", { model: generate.data.modelUsed })}</p>
      ) : null}
    </div>
  );
}
