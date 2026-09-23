// 对话消息区：气泡、操作条、思考轨迹行、生成中行、引用条。
//
// 与 Agent 页的消息渲染是两条独立实现（Agent 侧多了工具时间轴 / 授权卡片 /
// 产出物卡片）。这里只覆盖「普通对话」需要的部分。
//
// 版式取法 Cherry Studio 的对话面，三条规矩：
//   1. 助手消息**不套卡片** —— 30px 头像 + 名称/模型一行，正文直接铺在列里。
//      卡片边框会跟正文里的代码块、表格打架（两层容器套三层边框），而且助手一开口
//      就是"一块"，读起来比对话更像通知。
//   2. 用户消息是**浅色气泡**（bg-muted），不是主色实底 —— 满屏黑块把视觉重心全压在
//      提问上，而读的是回答；头像在气泡右侧，气泡最宽到「列满 - 头像槽」。
//   3. 操作条默认隐形，hover / 键盘聚焦才淡入，唯独最后一条助手消息常驻。行高按
//      26px 预留，所以出现与消失都不会推着正文跳版。
import { memo, useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangleIcon,
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  LanguagesIcon,
  Loader2Icon,
  NotebookPenIcon,
  RotateCcwIcon,
  SparklesIcon,
  Trash2Icon,
  UserRoundIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import type { ChatMessage } from "../../../bun/chat";
import { useChatStore } from "@stores/chat";
import { useT, useUILang } from "@stores/ui-lang";
import { Markdown } from "@components/markdown";
import { AssistantHeader, formatMessageTime } from "@components/assistant-header";
import {
  usePiContextMenu,
  actionMenuItems,
  type MessageActionItem,
} from "@components/pi-menu";
import {
  MessageTokenStats,
  formatDuration,
  useTokenStatsView,
} from "@components/token-stats";
import { noteDraftFromMessage } from "@/mainview/lib/note-draft";
import { persistedErrorMessage, serverErrorHint } from "@/mainview/lib/server-error";
import { cn } from "@/mainview/lib/utils";
import { chatImageUrl } from "../../../shared/server-info";
import { CitationBar } from "./citation-bar";

/** 头像槽：两侧都用同一个尺寸，消息正文的左右起点才对得齐。 */
const AVATAR_SLOT_CLASS = "flex size-[30px] shrink-0 items-center justify-center rounded-full";

/** 操作条：默认隐形，hover 或键盘聚焦（focus-within）时淡入。 */
const HOVER_REVEAL_CLASS =
  "opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/message:opacity-100";

/** 消息底部 meta 行：动作与时间/用量共用，26px 固定高度（出现时不挤动正文）。 */
const FOOTER_ROW_CLASS = "mt-1 flex min-h-6.5 items-center gap-1.5 leading-none";

function MessageImages({ images }: { images: string[] }) {
  if (images.length === 0) return null;
  return (
    <div className="flex max-w-full flex-wrap justify-end gap-1.5">
      {images.map((ref) => (
        <img
          key={ref}
          src={chatImageUrl(ref)}
          alt=""
          className="max-h-52 max-w-full rounded-xl object-contain"
        />
      ))}
    </div>
  );
}

/**
 * 这条消息的动作清单：hover 操作条与右键菜单读同一份（两个入口各写一遍必然走样）。
 * 复制 / 翻译 / 删除每条都有，重新生成只给助手消息。
 */
function useMessageActions({
  message,
  isStreamingMessage,
}: {
  message: ChatMessage;
  isStreamingMessage: boolean;
}) {
  const t = useT();
  const lang = useUILang((s) => s.lang);
  const queryClient = useQueryClient();
  const streaming = useChatStore((s) => s.streaming);
  const [copied, setCopied] = useState(false);
  const [noteSaved, setNoteSaved] = useState(false);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["conversations"] });
    queryClient.invalidateQueries({ queryKey: ["conversation", message.conversationId] });
  };

  const deleteMutation = useMutation({
    mutationFn: () =>
      rpcClient.deleteMessage({
        conversationId: message.conversationId,
        messageId: message.id,
      }),
    onSuccess: () => {
      useChatStore.getState().removeMessage(message.conversationId, message.id);
      invalidate();
    },
  });

  const regenerateMutation = useMutation({
    // 后端会流式写回新消息；先本地回退到这条之前，避免旧内容残留。
    onMutate: () => {
      useChatStore.getState().rewindMessages(message.conversationId, message.id);
      useChatStore.getState().setStreaming(true);
    },
    mutationFn: () =>
      rpcClient.regenerateMessage({
        conversationId: message.conversationId,
        messageId: message.id,
      }),
    onSuccess: invalidate,
    onError: () => {
      useChatStore.getState().setStreaming(false);
      invalidate();
    },
  });

  const translateMutation = useMutation({
    onMutate: () => useChatStore.getState().setStreaming(true),
    mutationFn: () =>
      rpcClient.translateMessage({
        conversationId: message.conversationId,
        messageId: message.id,
        // 目标语言跟随界面语言：以前写死 zh-CN，英文界面下点「翻译」得到的是中文译文。
        // 后端另支持 zh-TW / ja / ko / fr / de（见 bun/chat.ts 的 TARGET_LANG_LABEL），
        // 多语种入口等翻译菜单那轮再补。
        targetLang: lang === "en" ? "en" : "zh-CN",
      }),
    onSuccess: invalidate,
    onError: () => {
      useChatStore.getState().setStreaming(false);
      invalidate();
    },
  });

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — ignore
    }
  };

  /**
   * 一键存进「笔记」小应用：草稿规则在 `lib/note-draft.ts`（与 Agent 页共用）。
   * 只提示"已保存"，不跳走 —— 用户多半正在读这段回答，把他甩到别的应用是帮倒忙。
   */
  const handleSaveToNote = async () => {
    const draft = noteDraftFromMessage(message.content, t("notes.tagChat"));
    if (!draft) return;
    try {
      const saved = await rpcClient.miniappNotesSave({
        title: draft.title,
        body: draft.body,
        tags: draft.tags,
        day: draft.day,
      });
      setNoteSaved(true);
      window.setTimeout(() => setNoteSaved(false), 1500);
      void rpcClient.miniappLog({
        appId: "chat",
        event: "note.saved",
        message: saved?.note ? `note #${saved.note.id}` : "saved",
        detail: { chars: draft.body.length, tag: draft.tags[0] },
      });
    } catch (e) {
      // 失败不打断阅读（按钮不亮即已说明问题），但必须留下线索：
      // 这是"点了没反应"里最难查的一类 —— 用户以为存进去了，其实没有。
      void rpcClient.miniappLog({
        appId: "chat",
        event: "note.save_failed",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const busy = streaming || isStreamingMessage;
  const actions: MessageActionItem[] = [
    {
      key: "copy",
      label: copied ? t("chat.copied") : t("chat.copy"),
      icon: copied ? (
        <CheckIcon className="size-3.5 text-emerald-500" />
      ) : (
        <CopyIcon className="size-3.5" />
      ),
      onSelect: handleCopy,
      disabled: streaming || !message.content,
    },
    ...(message.role === "assistant"
      ? [
          {
            key: "save-to-note",
            label: noteSaved ? t("chat.savedToNote") : t("chat.saveToNote"),
            icon: noteSaved ? (
              <CheckIcon className="size-3.5 text-emerald-500" />
            ) : (
              <NotebookPenIcon className="size-3.5" />
            ),
            onSelect: handleSaveToNote,
            disabled: busy || !message.content,
          },
          {
            key: "regenerate",
            label: t("chat.regenerate"),
            icon: regenerateMutation.isPending ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <RotateCcwIcon className="size-3.5" />
            ),
            onSelect: () => regenerateMutation.mutate(),
            disabled: busy,
          },
        ]
      : []),
    {
      key: "translate",
      label: t("chat.translate"),
      icon: translateMutation.isPending ? (
        <Loader2Icon className="size-3.5 animate-spin" />
      ) : (
        <LanguagesIcon className="size-3.5" />
      ),
      onSelect: () => translateMutation.mutate(),
      disabled: streaming || !message.content,
    },
    {
      key: "delete",
      label: t("chat.delete"),
      icon: <Trash2Icon className="size-3.5" />,
      onSelect: () => deleteMutation.mutate(),
      disabled: busy,
      danger: true,
    },
  ];

  return { actions };
}

/**
 * 操作条按钮：26px 命中区、圆角 6px、静息时完全透明（Cherry 的取法）。
 * 生成中沿用「置灰而不是消失」：按钮忽隐忽现比置灰更像在闪。
 */
function MessageActionBar({ actions }: { actions: MessageActionItem[] }) {
  return (
    <div className="flex items-center gap-1">
      {actions.map((item) => (
        <Button
          key={item.key}
          variant="ghost"
          size="icon-xs"
          tooltip={item.label}
          onClick={item.onSelect}
          disabled={item.disabled}
          className="size-6.5 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {item.icon}
        </Button>
      ))}
    </div>
  );
}

/**
 * 助手消息的轨迹行：一行「已处理 · N 秒」，点开看这一轮的思考原文。
 *
 * 时长取自这一轮的实测耗时（生成中按实时值跳动）；没有统计的旧消息退回到
 * 只写「思考过程」，不再自己计时 —— 界面上不该出现和用量卡片对不上的秒数。
 */
function AssistantTraceRow({
  reasoning,
  streaming,
  workedMs,
}: {
  reasoning: string;
  streaming: boolean;
  workedMs?: number;
}) {
  const t = useT();
  const [open, setOpen] = useState(streaming);
  const wasStreaming = useRef(streaming);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 流式 → 结束 时自动折叠。
  useEffect(() => {
    if (wasStreaming.current && !streaming) setOpen(false);
    wasStreaming.current = streaming;
  }, [streaming]);

  // 展开且流式中时，思考内容跟随滚动。
  useEffect(() => {
    if (!open || !streaming) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [reasoning, open, streaming]);

  const label =
    workedMs != null
      ? t(streaming ? "chat.working.duration" : "chat.worked", {
          duration: formatDuration(t, workedMs),
        })
      : streaming
        ? t("chat.thinking")
        : t("chat.reasoning");

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={open ? t("chat.traceExpanded") : t("chat.traceCollapsed")}
        className={cn(
          "group flex w-full items-center gap-1.5 rounded-lg px-1 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
          open && "text-foreground",
        )}
      >
        {streaming ? (
          // 思考中给文字微光而不是转圈：它在"动"，但不像加载失败那样让人等。
          <span className="chat-shimmer shrink-0 font-medium">{label}</span>
        ) : (
          <>
            <BrainIcon className="size-3.5 shrink-0" />
            <span className="shrink-0 font-medium">{label}</span>
          </>
        )}
        {!open && (
          <span className="min-w-0 flex-1 truncate text-muted-foreground/60">
            {reasoning.replace(/\s+/g, " ").slice(0, 80)}
          </span>
        )}
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 transition-transform",
            open ? "rotate-180" : "opacity-60 group-hover:opacity-100",
          )}
        />
      </button>
      {open && (
        <div
          ref={bodyRef}
          className="mt-1 mb-1 max-h-48 overflow-y-auto rounded-r-lg border-l-2 border-border bg-muted/30 px-3 py-2 whitespace-pre-wrap text-xs leading-5 text-muted-foreground"
        >
          {reasoning}
        </div>
      )}
    </div>
  );
}

/**
 * 「生成中…」那一行：微光文字 + 已等待的秒数。
 *
 * 秒数必须在**一个 token 都还没出来**的静默期里继续走：模型加载、长提示词预填充、
 * 云端排队这几段能到几十秒，而这时界面上没有别的东西在动 —— 一行静止的转圈与
 * "卡死"在观感上没有区别。计时起点用本轮请求发出的时刻（store 的 runStartedAt），
 * 拿不到（刷新窗口后接上的推送）就从挂载时刻算起。
 */
function GeneratingRow() {
  const t = useT();
  const runStartedAt = useChatStore((s) => s.runStartedAt);
  const mountedAt = useRef(Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const elapsedMs = Math.max(0, now - (runStartedAt ?? mountedAt.current));
  return (
    <div className="flex items-center gap-2 py-1 text-sm">
      <span className="chat-shimmer font-medium">{t("chat.generating")}</span>
      {/* 头一秒不报数：那一瞬间还没什么好等的，蹦一个「0 ms」反而像在报错。 */}
      {elapsedMs >= 1000 ? (
        <span className="text-xs tabular-nums text-muted-foreground/70">
          {t("chat.generating.elapsed", { duration: formatDuration(t, elapsedMs) })}
        </span>
      ) : null}
    </div>
  );
}

/** 用户消息：附件 + 浅色气泡 + 右侧头像，meta 行（时间 + 操作）在气泡之下右对齐。 */
function UserBubbleMessage({
  message,
  actions,
  alwaysShowActions,
}: {
  message: ChatMessage;
  actions: MessageActionItem[];
  alwaysShowActions: boolean;
}) {
  const images = message.images ?? [];
  const hasText = message.content.trim().length > 0;

  return (
    <>
      <div className="flex max-w-[calc(100%-2.5rem)] items-start justify-end gap-2.5">
        <div className="flex min-w-0 flex-1 flex-col items-end gap-2">
          <MessageImages images={images} />
          {/* 只有附件没有文字时不留空气泡（empty:hidden 的等价物）。 */}
          {hasText && (
            <div className="max-w-full rounded-[10px] bg-muted px-4 py-2.5 text-sm leading-relaxed break-words whitespace-pre-wrap">
              {message.content}
            </div>
          )}
        </div>
        <span
          aria-hidden="true"
          className={cn(AVATAR_SLOT_CLASS, "mt-1.5 bg-muted text-muted-foreground")}
        >
          <UserRoundIcon className="size-4" />
        </span>
      </div>
      {/* 时间与操作整块淡入：气泡的位置永远不动，行高也一直占着。 */}
      <div
        className={cn(
          FOOTER_ROW_CLASS,
          "mr-[30px] w-[calc(100%-30px)] justify-end text-[10px] text-muted-foreground/70",
        )}
      >
        <div className={cn("flex items-center gap-2", HOVER_REVEAL_CLASS, alwaysShowActions && "opacity-100")}>
          <span className="shrink-0 tabular-nums">{formatMessageTime(message.createdAt)}</span>
          <MessageActionBar actions={actions} />
        </div>
      </div>
    </>
  );
}

/** 助手消息：头像 + 名称/模型 + 正文（无容器），meta 行左侧是操作、右侧是用量与时间。 */
function AssistantPlainMessage({
  message,
  actions,
  alwaysShowActions,
  isStreamingMessage,
  conversationModel,
}: {
  message: ChatMessage;
  actions: MessageActionItem[];
  alwaysShowActions: boolean;
  isStreamingMessage: boolean;
  conversationModel?: string;
}) {
  const t = useT();
  const { content, reasoning, citations } = message;
  // 后端把启动失败持久化为 "⚠️ <原始错误>"，这里补一行本地化的可操作提示。
  const rawError = persistedErrorMessage(content);
  const errorHint = rawError !== null ? serverErrorHint(t, rawError) : null;
  // 这一轮的实测耗时（生成中是实时值）—— 轨迹行与用量卡片读的是同一份数据。
  const view = useTokenStatsView(message, isStreamingMessage);
  const hasBody = Boolean(content) || errorHint !== null;

  return (
    <div className="flex w-full gap-2.5">
      <span aria-hidden="true" className={cn(AVATAR_SLOT_CLASS, "bg-primary/10 text-primary")}>
        <SparklesIcon className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <AssistantHeader model={view?.model ?? conversationModel} />
        <div className="mt-2 flex min-w-0 flex-col gap-2">
          {reasoning ? (
            <AssistantTraceRow
              reasoning={reasoning}
              streaming={isStreamingMessage}
              workedMs={view?.elapsedMs}
            />
          ) : null}
          {content ? (
            // 生成中交给 streamdown 的流式模式：半截的代码围栏 / 表格按未完成解析，
            // 否则每来一个 token 都可能把下面的段落闪成另一个样子。
            <Markdown content={content} mode={isStreamingMessage ? "streaming" : "static"} />
          ) : null}
          {errorHint && (
            <p className="flex items-start gap-1.5 rounded-lg bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 break-words">{errorHint}</span>
            </p>
          )}
          {/* 正文为空时不留空白：等首字给一行"生成中"，出错给错误行，其余什么都不画。 */}
          {!hasBody && isStreamingMessage ? <GeneratingRow /> : null}
          {!isStreamingMessage && citations && citations.length > 0 && (
            <CitationBar citations={citations} />
          )}
        </div>
        <div className={cn(FOOTER_ROW_CLASS, "justify-between")}>
          <div className={cn(HOVER_REVEAL_CLASS, alwaysShowActions && "opacity-100")}>
            <MessageActionBar actions={actions} />
          </div>
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                "text-[10px] tabular-nums text-muted-foreground/60",
                "opacity-0 transition-opacity duration-150 group-hover/message:opacity-100",
                alwaysShowActions && "opacity-100",
              )}
            >
              {formatMessageTime(message.createdAt)}
            </span>
            {/* 用量胶囊贴在右下角：图标是"对消息做什么"，它是"这次花了多少"，
                两者分开看更清楚；生成中它还会实时跳速度。 */}
            <MessageTokenStats
              message={message}
              conversationId={message.conversationId}
              streaming={isStreamingMessage}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  isStreamingMessage,
  conversationModel,
  alwaysShowActions = false,
}: {
  message: ChatMessage;
  isStreamingMessage: boolean;
  /** 会话当前模型：历史消息没有统计时，头部仍然能标出它当时用的模型。 */
  conversationModel?: string;
  /** 最后一条助手消息：操作条常驻（它是用户最可能马上要点的那个）。 */
  alwaysShowActions?: boolean;
}) {
  const isUser = message.role === "user";
  // 操作条与右键菜单是同一批动作的两个入口。
  const { actions } = useMessageActions({ message, isStreamingMessage });
  const menu = usePiContextMenu(actionMenuItems(actions));

  return (
    <div
      className={cn("group/message w-full", isUser && "flex flex-col items-end")}
      onContextMenu={menu.onContextMenu}
    >
      {isUser ? (
        <UserBubbleMessage
          message={message}
          actions={actions}
          alwaysShowActions={alwaysShowActions}
        />
      ) : (
        <AssistantPlainMessage
          message={message}
          actions={actions}
          alwaysShowActions={alwaysShowActions}
          isStreamingMessage={isStreamingMessage}
          conversationModel={conversationModel}
        />
      )}
      {menu.node}
    </div>
  );
}

/**
 * 流式输出时只有最后一条消息会被替换成新对象，其余消息引用不变；
 * memo 让历史气泡整段跳过重渲染（否则每个增量都会重渲染整个会话）。
 */
export const MemoizedMessageBubble = memo(MessageBubble);
