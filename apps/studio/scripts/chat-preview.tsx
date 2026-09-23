/**
 * 对话页的静态预览：把**真的**消息组件服务端渲染成 HTML，配上构建产物里的那份 CSS
 * —— 不起整个桌面应用就能看这一页长什么样（浅色 / 深色各一份）。
 *
 *   bun run --cwd apps/studio vite build          # 先出 CSS（新加的工具类才会在里面）
 *   bun run --cwd apps/studio scripts/chat-preview.tsx
 *
 * 数据写死：这里要看的是**版式与层级**（谁的块更重、间距多松、操作条什么时候出现），
 * 不是数据链路 —— 那条由 app/chat 的单测与应用内真宿主覆盖。
 * 想调版式就把窗口拖到 1100px 左右看，那是消息列（800px）刚好不被压扁的宽度。
 */
import { cpSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";

// 组件链里有 `electrobun/view`（经 @lib/rpc）与 Radix：都要 window 才能 import。
// 与 mainview 的单测同一套做法 —— SSR 期间不跑 effect，所以不会真的发 rpc。
const dom = new Window({ url: "http://localhost/" });
for (const key of ["window", "document", "navigator", "localStorage", "HTMLElement", "Element", "Node"] as const) {
  const value = (dom as unknown as Record<string, unknown>)[key];
  if (value !== undefined) (globalThis as unknown as Record<string, unknown>)[key] = value;
}

const { MemoizedMessageBubble } = await import("../src/mainview/app/chat/message");
const { groupChatTurns } = await import("../src/mainview/app/chat/turns");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("../src/mainview/components/ui/tooltip");
const { useUILang } = await import("../src/mainview/stores/ui-lang");
type ChatMessage = import("../src/bun/chat").ChatMessage;

// 中文界面（默认就是 zh，这里显式写出来，免得预览跟着系统语言变）。
useUILang.setState({ lang: "zh" });

const now = Date.now();
const MINUTE = 60_000;

const ANSWER = `这个正则的问题不在 \\\`\\\\d{4}\\\`，而在**分隔符**：你写的是 \\\`-\\\`，但输入里是中文全角连字符。

\`\`\`js
// 只匹配 ASCII 连字符，\`2024－01\` 这种全角输入必然落空
const strict = /^(\\d{4})-(\\d{2})-(\\d{2})$/;

// 想两种都收，就把分隔符写成字符组
const loose = /^(\\d{4})[-－](\\d{2})[-－](\\d{2})$/;
\`\`\`

三种写法的差别：

| 写法 | 匹配 \\\`2024-01-05\\\` | 匹配 \\\`2024－01－05\\\` | 备注 |
| --- | --- | --- | --- |
| \\\`-\\\` | ✅ | ❌ | 最严格，推荐入库前用 |
| \\\`[-－]\\\` | ✅ | ✅ | 兼容用户手输 |
| \\\`\\\\W\\\` | ✅ | ✅ | 太松，\\\`2024a01b05\\\` 也会过 |

另外两点：

1. 用 \\\`^...$\\\` 锚定整串；只写 \\\`\\\\d{4}\\\` 会在长文本里误命中。
2. 真要校验日期合法性（比如 \\\`2024-02-31\\\`），正则只能挡形状，值还得交给 \\\`Date\\\` 判断。`;

const messages: ChatMessage[] = [
  {
    id: 1,
    conversationId: 1,
    role: "user",
    content: "这段正则为什么匹配不上？输入是 2024－01－05，看起来没问题啊。",
    createdAt: now - 6 * MINUTE,
  },
  {
    id: 2,
    conversationId: 1,
    role: "assistant",
    reasoning:
      "先看锚点：^ 和 $ 都在，形状没问题。再看 \\d{4} —— 2024 是四位数字，也对。所以问题只可能出在分隔符上，用户贴的输入里那个连字符看着比 ASCII 的短横宽一点，八成是全角。",
    content: ANSWER,
    tokens: 812,
    stats: {
      tokens: 812,
      outputTokens: 812,
      inputTokens: 1240,
      cachedTokens: 1024,
      tokensPerSec: 42.5,
      endToEndTokensPerSec: 41.9,
      ttftMs: 380,
      elapsedMs: 19_300,
      generationMs: 19_100,
      reasoningTokens: 168,
      source: "usage",
      model: "Qwen3.5-14B-Instruct-Q5_K_M",
      provider: "llama.cpp",
    },
    citations: [
      {
        n: 1,
        kbId: 1,
        kbName: "产品手册",
        docId: 7,
        docName: "订单导入格式说明.md",
        seq: 3,
        snippet: "日期字段只接受 YYYY-MM-DD，分隔符为半角连字符。",
      },
      {
        n: 2,
        kbId: 1,
        kbName: "产品手册",
        docId: 12,
        docName: "常见导入失败原因.md",
        seq: 9,
        snippet: "全角符号混入是导入失败的第一大原因，占 37%。",
      },
    ],
    createdAt: now - 5 * MINUTE,
  },
  {
    id: 3,
    conversationId: 1,
    role: "user",
    content: "那用 Date 解析呢？",
    createdAt: now - 40_000,
  },
  {
    id: 4,
    conversationId: 1,
    role: "assistant",
    content: "",
    tokens: 24,
    createdAt: now - 4_000,
  },
];

function Conversation({ streaming }: { streaming: boolean }): ReactNode {
  const turns = groupChatTurns(messages);
  const lastAssistantId = [...messages].reverse().find((m) => m.role === "assistant")?.id ?? null;
  return createElement(
    "div",
    { className: "mx-auto flex w-full max-w-[50rem] flex-col gap-6 px-6 pt-6 pb-4" },
    turns.map((turn) =>
      createElement(
        "div",
        { key: turn.key, className: "flex flex-col gap-2" },
        turn.messages.map((m) =>
          createElement(MemoizedMessageBubble, {
            key: m.id,
            message: m,
            conversationModel: "Qwen3.5-14B-Instruct-Q5_K_M",
            isStreamingMessage: streaming && m.id === 4,
            alwaysShowActions: m.id === lastAssistantId,
          }),
        ),
      ),
    ),
  );
}

/** 输入框的壳：真组件要 rpc（模型列表 / 知识库），这里只摆出它的形状与尺寸。 */
function ComposerShell(): ReactNode {
  return createElement(
    "div",
    { className: "mx-auto flex w-full max-w-[50rem] flex-col gap-2" },
    createElement(
      "div",
      { className: "flex flex-col rounded-[20px] border bg-card shadow-sm" },
      createElement(
        "div",
        { className: "min-h-16 px-4 pt-3.5 text-[0.9rem] text-muted-foreground" },
        "输入消息，按 Enter 发送，Shift+Enter 换行",
      ),
      createElement(
        "div",
        { className: "flex h-10 items-center gap-1 px-2 py-1" },
        ["re", "ge", "kb"].map((k) =>
          createElement(
            "span",
            {
              key: k,
              className:
                "size-7 rounded-lg text-muted-foreground/40 text-xs flex items-center justify-center",
            },
            "◻",
          ),
        ),
        createElement("span", { className: "ml-auto text-xs text-muted-foreground/60" }, "Qwen3.5-14B"),
        createElement(
          "span",
          {
            className:
              "ml-1.5 flex size-7 items-center justify-center rounded-full text-primary text-sm",
          },
          "↑",
        ),
      ),
    ),
  );
}

function Greeting(): ReactNode {
  return createElement(
    "div",
    { className: "flex min-h-full flex-col justify-center" },
    createElement(
      "div",
      { className: "mx-auto flex w-full max-w-[50rem] flex-col items-center gap-3 px-6 text-center" },
      createElement(
        "span",
        {
          className:
            "flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground text-lg",
        },
        "🤖",
      ),
      createElement("h2", { className: "text-lg font-medium" }, "开始对话"),
      createElement(
        "p",
        { className: "max-w-sm text-sm text-muted-foreground" },
        "随便问点什么，回复会实时流式生成。",
      ),
    ),
  );
}

/** 「回到底部」浮标 + 输入框：贴在输入框正上方（-top-11）。 */
function ComposerDock({ withJump }: { withJump: boolean }): ReactNode {
  return createElement(
    "div",
    { className: "relative shrink-0 px-4 pt-1 pb-4" },
    createElement("div", {
      "aria-hidden": "true",
      className: "pointer-events-none absolute inset-x-0 -top-8 h-8 bg-gradient-to-t from-background to-transparent",
    }),
    withJump &&
      createElement(
        "button",
        {
          type: "button",
          className:
            "absolute -top-11 left-1/2 z-10 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-background/95 text-foreground shadow-[0_10px_24px_rgba(15,23,42,0.14),0_3px_8px_rgba(15,23,42,0.08)]",
        },
        "↓",
      ),
    createElement(ComposerShell),
  );
}

const CSS_DIR = join(import.meta.dir, "..", "dist", "assets");
const cssFile = readdirSync(CSS_DIR).find((name) => name.endsWith(".css"));
if (!cssFile) {
  console.error("[preview] 没找到构建产物 CSS：先跑 `bun run vite build`");
  process.exit(1);
}

const out = join(tmpdir(), "omni-chat-preview");
mkdirSync(join(out, "assets"), { recursive: true });
// 整个 assets 目录拷过来：CSS 里的字体是相对路径，只拷 CSS 会掉回系统字体。
cpSync(CSS_DIR, join(out, "assets"), { recursive: true });

function page(title: string, body: string, theme: "light" | "dark", showActions = false): string {
  return `<!doctype html>
<html lang="zh"${theme === "dark" ? ' class="dark"' : ""}>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="stylesheet" href="./assets/${cssFile}" />
<style>
  html,body{margin:0;height:100%}
  body{overflow:hidden}
  #root{display:flex;flex-direction:column;height:100%}
  /* 预览专用：把 hover 才出现的东西显出来（操作条 / 时间），静态图里才看得到 */
  body.show-actions [class*="opacity-0"]{opacity:1 !important}
</style>
</head>
<body class="bg-background text-foreground${showActions ? " show-actions" : ""}">
  <div id="root">
    <div class="h-8 shrink-0"></div>
    ${body}
  </div>
  <div style="position:fixed;left:12px;bottom:8px;font:11px/1.4 system-ui;opacity:.45">${title}</div>
</body>
</html>`;
}

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const render = (node: ReactNode) =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(TooltipProvider, null, node),
    ),
  );

// 会话（生成中）：能同时看到助手正文、思考轨迹、引用、常驻操作条与微光"生成中"。
const conversation = createElement(
  "div",
  { className: "flex min-h-0 flex-1 flex-col", style: { overflow: "hidden" } },
  createElement(
    "div",
    { className: "min-h-0 flex-1 overflow-hidden" },
    createElement(Conversation, { streaming: true }),
  ),
  createElement(ComposerDock, { withJump: true }),
);

// 空会话：问候语在输入框上方居中。
const empty = createElement(
  "div",
  { className: "flex min-h-0 flex-1 flex-col" },
  createElement("div", { className: "min-h-0 flex-1 overflow-hidden" }, createElement(Greeting)),
  createElement(ComposerDock, { withJump: false }),
);

for (const theme of ["light", "dark"] as const) {
  writeFileSync(join(out, `chat.${theme}.html`), page("对话 · 有消息（生成中）", render(conversation), theme));
  writeFileSync(join(out, `empty.${theme}.html`), page("对话 · 空会话", render(empty), theme));
}
// 多一张 hover 态：操作条与时间是淡入的，静态图里看不到，得手动把它们显出来核对
// —— 要看的正是"出现时不应该推挤正文"（所以这张图里正文的位置必须和上面那张一致）。
writeFileSync(
  join(out, "chat.light.actions.html"),
  page("对话 · hover 态（操作条全部显形）", render(conversation), "light", true),
);
console.log(`[preview] ${out}/chat.{light,dark}.html 与 empty.{light,dark}.html（CSS: ${cssFile}）`);
