// 对话应用入口：会话编排（选会话 / 拉历史 / 发消息 / 停止）+ 消息区 + 输入区。
//
// 拆分为三个文件：本文件（编排）、`message.tsx`（消息渲染）、`composer.tsx`（输入区）。
// 列宽与「按轮分组」两个纯函数分别放在 `layout.ts` / `turns.ts`（都有单测）。
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangleIcon,
  ArrowDownIcon,
  BotIcon,
  Loader2Icon,
  SquareTerminalIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import type { ChatMessage } from "../../../bun/chat";
import { useChatStore } from "@stores/chat";
import { useAppStore } from "@stores/app";
import { useT } from "@stores/ui-lang";
import { useRouter } from "@stores/router";
import { useServedStore } from "@stores/served";
import { useServerMessageSync } from "@hooks/use-server-message-sync";
import { cn } from "@/mainview/lib/utils";
import { MemoizedMessageBubble } from "./message";
import { ChatComposer, type ChatSendPayload } from "./composer";
import { CHAT_COLUMN_CLASS } from "./layout";
import { groupChatTurns } from "./turns";

/** 距底部多近算「在看最新一条」：留一点余量，贴底时不会被 1px 的抖动判成"翻上去了"。 */
const FOLLOW_THRESHOLD_PX = 64;

/**
 * 空会话的问候：头像 + 一句话，居中在输入框之上。
 *
 * 刻意不做"推荐问题卡片"：没有数据支撑的建议问题只是噪音，而这块地方
 * 真正的用途是让用户第一眼看到"输入框在哪儿、能问什么"。
 */
function ChatGreeting() {
  const t = useT();
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <span
        aria-hidden="true"
        className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground"
      >
        <BotIcon className="size-6" />
      </span>
      <h2 className="text-lg font-medium">{t("chat.startConversation")}</h2>
      <p className="max-w-sm text-sm text-muted-foreground">{t("chat.askAnything")}</p>
    </div>
  );
}

/** 「回到底部」浮标：用户往上翻时才出现，贴在输入框正上方（不挡消息）。 */
function JumpToBottomButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "absolute -top-11 left-1/2 z-10 flex size-9 -translate-x-1/2 items-center justify-center rounded-full",
        "border border-border bg-background/95 text-foreground backdrop-blur-sm transition-colors hover:bg-accent",
        "shadow-[0_10px_24px_rgba(15,23,42,0.14),0_3px_8px_rgba(15,23,42,0.08)]",
        "dark:shadow-[0_12px_28px_rgba(0,0,0,0.34),0_3px_10px_rgba(0,0,0,0.22)]",
      )}
    >
      <ArrowDownIcon className="size-4" />
    </button>
  );
}

function ChatMessages({ conversationId }: { conversationId: number }) {
  const queryClient = useQueryClient();
  const t = useT();
  const setRoute = useRouter((s) => s.setRoute);
  const activeMessages = useChatStore((s) => s.activeMessages);
  const streaming = useChatStore((s) => s.streaming);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 跟随模式：没往上翻就跟着新内容贴底；翻上去了就别抢用户的滚动条
  // （本地模型一边出字一边把视口拽回底部，是"想回看上一段"时最烦人的一件事）。
  const followRef = useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const following = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD_PX;
    followRef.current = following;
    setShowJumpToBottom(!following);
  };

  const jumpToBottom = (behavior: ScrollBehavior = "smooth") => {
    const el = scrollRef.current;
    followRef.current = true;
    setShowJumpToBottom(false);
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  };

  const convQuery = useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: () => rpcClient.getConversation({ id: conversationId }),
  });

  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  const isRemoteMode = settingsQuery.data?.settings?.SERVER_MODE === "remote";

  // 本地就绪状态看**已启动模型**：活动实例在加载中 / 报错，或者一个都没启动。
  const servedModels = useServedStore((s) => s.models);
  const activeServed = servedModels.find((m) => m.isActive);
  const localReady = servedModels.some(
    (m) => m.status === "running" || m.status === "starting" || m.status === "downloading",
  );
  const serverStarting =
    !isRemoteMode &&
    (activeServed?.status === "starting" || activeServed?.status === "downloading");
  const serverFailed = !isRemoteMode && activeServed?.status === "error";
  // 端口上可能已经有别人起的服务（`omi serve` / 自建 llama-server）：探到就不提示启动。
  const { data: localStatus } = useQuery({
    queryKey: ["server-status"],
    queryFn: () => rpcClient.getServerStatus(),
    enabled: !isRemoteMode && !localReady,
    refetchInterval: 8000,
  });
  const noLocalModel =
    !isRemoteMode && !localReady && localStatus !== undefined && !localStatus.reachable;

  // 切会话清流式态、同会话内只做合并（规则与 Agent 页共用一份，见 use-server-message-sync）。
  useServerMessageSync(conversationId, convQuery.data);

  const lastMessage = activeMessages[activeMessages.length - 1];
  useEffect(() => {
    if (!followRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeMessages.length, lastMessage?.content, lastMessage?.reasoning]);

  // 切会话 = 换了一屏：回到最新一条，并把"跟随"恢复成默认状态。
  useEffect(() => {
    followRef.current = true;
    setShowJumpToBottom(false);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversationId]);

  const sendMutation = useMutation({
    mutationFn: (payload: ChatSendPayload) =>
      rpcClient.sendChatMessage({
        conversationId,
        content: payload.content,
        images: payload.images,
        webSearch: payload.search,
        files: payload.files,
        kbIds: payload.kbIds,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
    },
    onError: (err: unknown) => {
      // RPC 失败且没收到 chatDone（后端异常路径）——解除输入锁定并展示错误，避免"发了没反应"。
      // 用幂等兜底：后端的早退路径也会推 chatDone，两条都到时不该出现两个 ⚠️ 气泡。
      useChatStore.getState().setStreaming(false);
      useChatStore
        .getState()
        .finalizeTurnIfPending(
          conversationId,
          `⚠️ ${err instanceof Error ? err.message : String(err)}`,
        );
    },
  });

  const stopMutation = useMutation({
    mutationFn: () => rpcClient.stopChatGeneration({ conversationId }),
    onSuccess: () => {
      // 后端会照常发一条 chatDone（保留已生成的部分），这里先解除锁定，
      // 免得停止请求本身失败时按钮卡在「停止」上。
      useChatStore.getState().setStreaming(false);
    },
  });

  const handleSend = (payload: ChatSendPayload) => {
    const now = Date.now();
    useChatStore.getState().setActiveMessages([
      ...activeMessages,
      {
        id: now,
        conversationId,
        role: "user",
        content: payload.content,
        images: payload.images,
        createdAt: now,
      } satisfies ChatMessage,
    ]);
    useChatStore.getState().setStreaming(true);
    // 自己发的消息一定要看见 —— 哪怕刚才在翻历史。
    followRef.current = true;
    setShowJumpToBottom(false);
    sendMutation.mutate(payload);
  };

  const hasMessages = activeMessages.length > 0;
  // 按轮分组：轮内紧、轮间松（间距差就是"这一轮说到哪儿"的分隔符）。
  const turns = useMemo(() => groupChatTurns(activeMessages), [activeMessages]);
  // 最后一条助手消息的操作条常驻：它刚出完字，用户最可能马上要复制 / 重新生成。
  const lastAssistantId = useMemo(() => {
    for (let i = activeMessages.length - 1; i >= 0; i -= 1) {
      const m = activeMessages[i];
      if (m && m.role === "assistant") return m.id;
    }
    return null;
  }, [activeMessages]);

  const notice =
    noLocalModel || serverStarting || (sendMutation.isPending && serverFailed) ? (
      <div
        className={cn(
          "flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs",
          serverFailed
            ? "border-destructive/30 bg-destructive/10 text-destructive"
            : noLocalModel
              ? "border-border bg-muted/50 text-muted-foreground"
              : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
        )}
      >
        {noLocalModel || serverFailed ? (
          <AlertTriangleIcon className="size-3.5 shrink-0" />
        ) : (
          <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
        )}
        <span className="truncate">
          {noLocalModel
            ? t("chat.noLocalModel")
            : serverFailed
              ? t("server.startFailed")
              : activeServed?.status === "downloading"
                ? t("server.startingModel")
                : t("server.waitingForModel")}
        </span>
        {noLocalModel ? (
          <Button
            variant="outline"
            size="xs"
            className="ml-auto h-6 shrink-0"
            onClick={() => setRoute({ path: "settings", tab: "logs" })}
          >
            <SquareTerminalIcon data-icon="inline-start" />
            {t("chat.modelStartInConsole")}
          </Button>
        ) : (
          serverStarting && (
            <span className="ml-auto h-1 w-20 shrink-0 overflow-hidden rounded-full bg-amber-500/20">
              <span className="block h-full w-1/2 animate-pulse rounded-full bg-amber-500" />
            </span>
          )
        )}
      </div>
    ) : null;

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div
          className={cn(
            CHAT_COLUMN_CLASS,
            // 空会话时整列竖向居中（问候语落在输入框上方，读起来像"在跟它说话"）；
            // 有消息后按正常流从顶部排 —— 居中会把两三条消息吊在半空中。
            "flex min-h-full flex-col gap-6 px-6 pt-6 pb-4",
            !hasMessages && "justify-center",
          )}
        >
          {!hasMessages ? (
            <ChatGreeting />
          ) : (
            turns.map((turn) => (
              <div key={turn.key} className="flex flex-col gap-2">
                {turn.messages.map((m) => (
                  <MemoizedMessageBubble
                    key={m.id}
                    message={m}
                    conversationModel={convQuery.data?.conversation?.modelId ?? undefined}
                    isStreamingMessage={
                      streaming && m.id === activeMessages[activeMessages.length - 1]?.id
                    }
                    alwaysShowActions={m.id === lastAssistantId}
                  />
                ))}
              </div>
            ))
          )}
        </div>
      </div>

      <div className="relative shrink-0 px-4 pt-1 pb-4">
        {/* 消息滚到输入框底下时淡出（而不是被一条横线切断）：输入框是浮在这一层上的。 */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 -top-8 h-8 bg-gradient-to-t from-background to-transparent"
        />
        {showJumpToBottom && (
          <JumpToBottomButton label={t("chat.scrollToBottom")} onClick={() => jumpToBottom()} />
        )}
        <ChatComposer
          conversationId={conversationId}
          streaming={streaming}
          sendPending={sendMutation.isPending}
          onSend={handleSend}
          onStop={() => stopMutation.mutate()}
          stopPending={stopMutation.isPending}
          notice={notice}
        />
      </div>
    </div>
  );
}

export function ChatWindow() {
  const t = useT();
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const activeApp = useAppStore((s) => s.activeApp);
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: () => rpcClient.createConversation({ app: activeApp }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      useChatStore.getState().upsertConversation(data.conversation);
      useChatStore.getState().setActiveConversation(data.conversation.id);
      useChatStore.getState().setActiveMessages([]);
      useChatStore.getState().setStreaming(false);
    },
  });

  const conversationsQuery = useQuery({
    queryKey: ["conversations", activeApp],
    queryFn: () => rpcClient.listConversations({ app: activeApp }),
  });

  // 进入对话时：优先打开一个已有的“空会话”（没有消息的），仅在没有空会话时才新建。
  // 避免反复进入对话页积累一大堆空白 session。
  useEffect(() => {
    if (activeConversationId != null) return;
    if (conversationsQuery.isLoading && !conversationsQuery.data) return;
    const empty = conversationsQuery.data?.conversations?.find(
      (c) => (c.messageCount ?? 0) === 0,
    );
    if (empty) {
      useChatStore.getState().setActiveConversation(empty.id);
      useChatStore.getState().setActiveMessages([]);
      useChatStore.getState().setStreaming(false);
    } else if (!createMutation.isPending) {
      createMutation.mutate();
    }
  }, [
    activeConversationId,
    activeApp,
    conversationsQuery,
    conversationsQuery.isLoading,
    createMutation.isPending,
  ]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {activeConversationId ? (
        <ChatMessages conversationId={activeConversationId} />
      ) : (
        <div className="flex flex-1 items-center justify-center">
          {createMutation.isPending ? (
            <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
          ) : (
            <div className="flex flex-col items-center gap-2 text-center">
              <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <BotIcon className="size-7" />
              </div>
              <p className="text-sm font-medium">{t("chat.placeholder.new")}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
