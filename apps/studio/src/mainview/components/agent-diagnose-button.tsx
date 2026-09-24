/**
 * 「让 Agent 解决」：把一次失败连同现场，开一个新的 Agent 会话填进输入框。
 *
 * 所有"启动失败 / 安装失败"的地方共用这一个按钮（JEV 本地运行时、本地模型的启动…），
 * 所以现场的格式在这里统一：一句说明要它做什么 → 报错原文 → 环境与参数 → 日志末尾。
 * 这正是人工排查时一条条去翻的东西；带齐了，Agent 第一轮就能动手，而不是先反问。
 *
 * **只填不发**：诊断往往要动这台机器上的环境（装依赖、改路径、删缓存），发不发、要不要
 * 先补一句自己的情况，由用户决定。
 *
 * 日志可以是现成的数组，也可以是一个取日志的函数 —— 本地模型的日志要到点下去的那一刻
 * 才去主进程取，免得每张卡片常驻一份几万字的日志。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BotIcon, Loader2Icon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { useAgentStore } from "@stores/agent";
import { useAppStore } from "@stores/app";
import { useChatStore } from "@stores/chat";
import { useRouter } from "@stores/router";
import { useT } from "@stores/ui-lang";
import { Button } from "@ui/button";
import { activateNewSession } from "@/mainview/app/agent/new-session";
import { buildDiagnosisPrompt } from "./agent-diagnose-prompt";

export type AgentDiagnoseProps = {
  /** 第一段：要 Agent 做什么（"本地模型起不来，请诊断并修好…"）。 */
  intro: string;
  /** 报错原文。 */
  error: string;
  /** 环境与参数，一行一条（"引擎：llama.cpp"、"模型：/path"…）。 */
  context?: string[];
  /** 日志：现成的行，或点下去时再取的函数。 */
  logs?: string[] | (() => Promise<string[]>);
  label?: string;
  size?: "xs" | "sm";
};

export function AgentDiagnoseButton({ intro, error, context, logs, label, size = "sm" }: AgentDiagnoseProps) {
  const t = useT();
  const queryClient = useQueryClient();
  // 和 Agent 页同一个 queryKey：那边取过的话直接命中缓存。
  const workspace = useQuery({
    queryKey: ["agent-workspace"],
    queryFn: () => rpcClient.getAgentWorkspace(undefined),
  });

  const diagnose = useMutation({
    mutationFn: async () => {
      let lines: string[] = [];
      try {
        lines = typeof logs === "function" ? await logs() : (logs ?? []);
      } catch {
        // 取不到日志也照样走：报错原文与环境已经够 Agent 开始了。
      }
      const prompt = buildDiagnosisPrompt({ intro, error, context, logs: lines });
      const { session } = await rpcClient.createAgentSession({});
      return { session, prompt };
    },
    onSuccess: ({ session, prompt }) => {
      activateNewSession(queryClient, session, workspace.data?.workspace ?? "");
      // Agent 的编辑器消费这份草稿（与"回到这条提问"同一套机制）。
      useChatStore.getState().setPendingPrompt(prompt);
      /*
       * 三步缺一不可（与通知铃铛跳会话同一套）：切到 Agent、切回主路由、落在对话子视图。
       * 只切 activeApp 的话，从「设置 → 模型库」里点下去界面纹丝不动 —— 路由还停在
       * settings，主区根本不渲染 Agent。这正是真机上点了没反应的那一次。
       */
      useAppStore.getState().setActiveApp("agent");
      useAgentStore.getState().setSubView("chat");
      useRouter.getState().setRoute({ path: "index" });
    },
  });

  return (
    <Button size={size} variant="outline" className="gap-1" disabled={diagnose.isPending} onClick={() => diagnose.mutate()}>
      {diagnose.isPending ? <Loader2Icon className="size-3 animate-spin" aria-hidden /> : <BotIcon className="size-3" aria-hidden />}
      {label ?? t("agent.diagnose")}
    </Button>
  );
}
