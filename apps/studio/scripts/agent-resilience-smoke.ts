/**
 * 复杂任务端到端（resilience）：把这一轮补的机制塞进**同一条任务**里同时发生。
 *
 * 已有验证的分工：单测证明"每个判据单独对"，`agent-live-check` 证明"每个场景单独对"。
 * 两者都没回答的问题是：**它们在同一条任务里同时发生时会不会互相打架**。
 * 这个脚本用一条真实形状的任务把下面这些事串起来：
 *
 * ```
 *   用户：resilience-task：统计一下这批日志，写份报告
 *     ├─ 传输层：前两次请求被 503 打回（模型还在加载）→ 内核重试
 *     ├─ 工具：bash `seq 1 30000` → 输出 17 万字符 → 截断（6144 上限）+ 转存
 *     ├─ 回合中途流被掐断（有半截正文）→ 摘掉空壳 + continue() 重发
 *     ├─ 空回合（服务端给了个空消息）→ harness 提醒
 *     ├─ 模型照着提示里的路径 read_file 读回转存的原文（分页读到第 3 万行）
 *     ├─ 两条 head（各 210k / 120k 字符）→ 与前面累积把 8k 窗口顶穿 → 触发压缩
 *     ├─ 派一个子智能体（只读）→ 子智能体也遇到空回合 → 同样被提醒
 *     ├─ 写报告到工作区（产出物登记）
 *     └─ 收尾
 * ```
 *
 * 这个脚本真正要证明的四条性质（单点场景看不出来的）：
 * 1. **重发不重复副作用**：已经跑成功的工具调用不会因为重发再跑一遍（不是"重来一轮"）；
 * 2. **失败那轮的半截正文会被收回**：不会和重试后的正文一起留在同一个气泡里；
 * 3. **harness 消息不落库**：提醒 / 重试只活在这一次运行里，会话历史里仍是 1 问 1 答；
 * 4. **转存提示是可执行的**：模型能顺着提示里的路径把被截断的原文读回来。
 *
 * 跑法：`bun run scripts/agent-resilience-smoke.ts`（已接进 test:smoke）。
 * 全程用内置脚本化桩服务，确定性、不依赖任何真实推理服务。
 *
 * 压缩断言（第 7 节）为什么靠「累积」而不是「单条大输出」：单条工具结果的上限
 * 是按上下文窗口的 25% 算的（`agent-spill.ts` 的 `toolOutputCharLimit`，随窗口等比缩放），
 * 8k 窗口下约 6144 字符 / 约 1500–2000 token —— 单条顶不穿 60% 的压缩预算，
 * 把窗口调小也没用（上限等比缩小）。真实的压力是多条大输出叠加：这条任务里
 * 三截被截断的 bash 结果（`seq` + 两条 `head`）加 read_file / 子智能体 / 写文件，
 * 累积超过预算，压缩才在中途触发。这正是压缩机制要对付的情形，而不是靠
 * 改 `AGENT_COMPACT_MODE` / `SERVER_CTX_SIZE` / 模型 id 去凑。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { sseChunk, startStubLlm, textChunks, toolCallChunks } from "../src/bun/test-stub-llm";

const dataDir = mkdtempSync(path.join(tmpdir(), "omni-resilience-"));
process.env.OMNI_DATA_DIR = dataDir;
const workspace = mkdtempSync(path.join(tmpdir(), "omni-resilience-ws-"));

// ---------------------------------------------------------------------------
// 脚本化桩服务
// ---------------------------------------------------------------------------
/**
 * 被掐断的流：有正文增量、但既没有 `finish_reason` 也没有 `[DONE]`。
 * 真实世界的样子是网关 / 服务端中途断开 —— pi-ai 会把它变成
 * `stopReason=error`、`errorMessage="Stream ended without finish_reason"`，
 * 而这条文本命中可重试判据（"ended without"）。半截正文则是给
 * "重发要把旧半截收回去"这条性质准备的。
 */
const BROKEN_PARTIAL_TEXT = "我先看看输出，然后统计一下";
function brokenStreamChunks(model: string): string[] {
  return [
    sseChunk(model, { role: "assistant", content: "" }),
    sseChunk(model, { reasoning_content: "先看一眼…" }),
    sseChunk(model, { content: BROKEN_PARTIAL_TEXT }),
  ];
}

/** 每次请求的观测记录（断言用）。 */
const seen = {
  /** 被打回的 503 次数。 */
  unavailable503: 0,
  /** 假造的"流被掐断"次数。 */
  brokenStreams: 0,
  /** 主 Agent 收到的空回合次数。 */
  emptyTurns: 0,
  /** 子智能体收到的请求数。 */
  subagentRequests: 0,
  /** 摘要调用的次数（压缩确实走了摘要路径）。 */
  summaryCalls: 0,
  /** 模型从转存提示里抄回来的路径（证明提示是可执行的）。 */
  readBackPath: null as string | null,
  /** 每次请求的最后一条 user 消息，用于断言提醒消息的形状。 */
  userPrompts: [] as string[],
  /**
   * 剧本进度：**已经发出过几个工具调用**。
   *
   * 不能用"请求里工具结果的条数"当进度 —— 压缩会改写历史（这正是本任务要测的东西），
   * 被摘掉一条旧工具结果之后计数会倒退，于是同一个步骤被演两遍。
   * 第一次跑就踩到了：`task` 被调了两次（第二次子智能体是白跑的）。
   */
  emittedToolCalls: 0,
  /** 请求里出现"线上协议不合法"的次数（孤儿工具结果 / 未结算的工具调用）。 */
  protocolViolations: [] as string[],
  /** 刚掐断过流：下一个请求就是重发请求，要检查它是不是"接着发"。 */
  awaitingRetry: false,
  /** 重发请求里是否**还带着**那条已经跑完的工具结果（证明是 continue 而不是重开一轮）。 */
  retryKeptToolResult: false,
  /** 重发请求里任务陈述出现的次数（>1 = 把这一轮重开了，上下文里会有两条同样的任务）。 */
  retryTaskRepeats: 0,
  /**
   * 本轮**第一次**请求里任务陈述出现的次数。
   * 建会话时如果把"本轮刚落库的那条用户消息"也回填进历史，这里就会是 2 ——
   * 任务描述、时间提醒、召回记忆、附件路径会整段翻倍。
   */
  firstRequestTaskRepeats: 0,
  /**
   * 两次 `head -c` 各自读取的字节数（断言用）：桩在发出 head 工具调用时填写，
   * 汇报与断言都从这个数说话，而不是靠「命令看起来长」。
   */
  headLines: [] as number[],
};

/**
 * 线上协议合法性：`tool` 消息必须紧跟带对应 `tool_call_id` 的 assistant 消息。
 *
 * 这条是本任务最想钉住的一类 400：压缩会改写历史，切得不好就会出现
 * 「工具结果还在、发起它的助手消息没了」或者反过来的残局 —— 真实服务端会**直接 400**，
 * 而桩服务（以及单测）默认不会发现。所以这里对**每一个进来的请求**做一次校验。
 */
function protocolViolation(
  messages: { role: string; content?: unknown; tool_calls?: unknown }[],
): string | null {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const id = (call as { id?: string }).id;
        if (id) pending.add(id);
      }
      continue;
    }
    if (message.role === "tool") {
      const id = (message as { tool_call_id?: string }).tool_call_id;
      if (!id || !pending.has(id)) return `孤儿工具结果：${id ?? "(无 id)"}`;
      pending.delete(id);
      continue;
    }
    if (pending.size > 0)
      return `工具调用还没结算就接了 ${message.role} 消息：${[...pending].join(",")}`;
  }
  return pending.size > 0 ? `请求结尾有未结算的工具调用：${[...pending].join(",")}` : null;
}

/**
 * 生成「带编号的行」形式的超长命令输出（`seq 1 30000` / `grep -n` 的样子）。
 * 每条 = 5 位数字 + `|` + 50 个字母 = 60 字符 / 15 token（英文口径，`shared/token-estimate.ts`），
 * 所以 n 行 ≈ 60n 字符 / 15n token。取 n = 3500 与 2000 两条，各自 ≈ 210k / 120k 字符，
 * 被 `toolOutputCharLimit`（8k 窗口 → 6144 字符）截断后，每条 ≈ 6000 字符 / 1500 token；
 * 三截 bash + read_file + 子智能体 + 写文件，累积远超预算（8k 窗口 × 60% ≈ 4915 token）。
 */
function longLines(n: number): string {
  let s = "";
  for (let i = 1; i <= n; i++) s += `${String(i).padStart(5, "0")}|${"abcdefg".repeat(8)}\n`;
  return s;
}

/**
 * 内存里的 AgentMessage 换写成线上协议形状，好让同一个校验器也能检查**压缩结果**。
 *
 * 两种形状不一样是刻意的（`toolResult` vs `tool`、内容块 vs `tool_calls` 字段），
 * 所以"压缩后还合法吗"必须在换写之后再判 —— 否则校验的是另一个东西。
 */
function toWireShape(
  messages: { role?: string; content?: unknown }[],
): { role: string; content?: unknown; tool_calls?: unknown }[] {
  return messages.map((message) => {
    const content = Array.isArray(message.content) ? message.content : [];
    if (message.role === "assistant") {
      const calls = content
        .filter((block) => (block as { type?: string }).type === "toolCall")
        .map((block) => ({ id: (block as { id?: string }).id ?? "" }));
      return calls.length
        ? { role: "assistant", tool_calls: calls }
        : { role: "assistant", content };
    }
    if (message.role === "toolResult") {
      return { role: "tool", tool_call_id: (message as { toolCallId?: string }).toolCallId ?? "" };
    }
    return { role: message.role ?? "unknown", content };
  });
}

const stub = startStubLlm({
  respond: async (request) => {
    const { model, messages } = request;
    const system = messages.find((message) => message.role === "system")?.content;
    const systemText = typeof system === "string" ? system : "";
    const lastUser = messages.filter((message) => message.role === "user").pop()?.content;
    const lastUserText = typeof lastUser === "string" ? lastUser : JSON.stringify(lastUser ?? "");
    if (lastUserText.trim()) seen.userPrompts.push(lastUserText);
    const violation = protocolViolation(messages);
    if (violation) seen.protocolViolations.push(violation);

    const stream = (chunks: string[]) =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(new TextEncoder().encode(chunk));
              await new Promise((resolve) => setTimeout(resolve, 3));
            }
            // 正常流以 [DONE] 收尾；被掐断的流不给（见 brokenStreamChunks 的说明）。
            if (
              chunks.some(
                (chunk) =>
                  chunk.includes('"finish_reason":"stop"') ||
                  chunk.includes('"finish_reason":"tool_calls"'),
              )
            ) {
              controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            }
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );

    // ── 压缩摘要调用（`agent-summary.ts` 的 SUMMARY_SYSTEM_PROMPT）──────────
    // 大输出会把 8k 窗口顶穿，压缩必然会来问一次。给它一份合法的五段式摘要，
    // 让摘要路径真的走通（而不是每次都失败退回裁剪）。
    if (systemText.includes("对话压缩助手")) {
      seen.summaryCalls += 1;
      return stream(
        textChunks(
          model,
          [
            "## 目标",
            "统计日志并写报告。",
            "## 已完成",
            "已跑 `seq 1 30000`，输出超限已转存。",
            "## 关键结论",
            "总行数 30000。",
            "## 涉及的文件",
            "（无）",
            "## 未解决 / 下一步",
            "写报告。",
          ].join("\n"),
        ),
      );
    }

    // ── 子智能体（`agent.ts` 给它的系统提示以这句话开头）────────────────────
    // 注意判据要够具体：主 Agent 的系统提示里也写着"子智能体"（委派准则那一条），
    // 用 /子智能体/ 会把主线自己当成子智能体 —— 这个坑第一次跑就踩到了。
    if (systemText.startsWith("你是 LlamaDesk 的子智能体")) {
      seen.subagentRequests += 1;
      // 第一次给它一个空回合：子智能体的失败在主线上只表现为"（无输出）"，最该被自愈兜住。
      if (seen.subagentRequests === 1) {
        return stream([sseChunk(model, { role: "assistant", content: "" }, "stop")]);
      }
      return stream(textChunks(model, "结论：工作区里有 reports/ 目录，可以往里写报告。"));
    }

    if (!/resilience-task/.test(seen.userPrompts[0] ?? "")) {
      return stream(textChunks(model, "（未预期的会话）"));
    }

    // 本轮的第一次请求：顺手数一下任务陈述出现了几次（建会话的历史回填很容易重复一条）。
    if (seen.firstRequestTaskRepeats === 0) {
      seen.firstRequestTaskRepeats = messages.filter(
        (message) =>
          message.role === "user" &&
          JSON.stringify(message.content ?? "").includes("resilience-task"),
      ).length;
    }

    // ── 主 Agent 的剧本 ────────────────────────────────────────────────
    // 进度用**自己发出过几个工具调用**（单调递增），不看请求里的工具结果条数 ——
    // 压缩会改写历史，按条数判断会让同一步被演两遍。
    if (seen.emittedToolCalls === 0) {
      // 1. 传输层：前两次直接 503（`retry-after: 0` 让退避不必真的等）。
      if (seen.unavailable503 < 2) {
        seen.unavailable503 += 1;
        return new Response("model is loading", { status: 503, headers: { "retry-after": "0" } });
      }
      // 2. 开工：跑一条输出巨大的命令（远超单条工具结果上限 → 转存）。
      seen.emittedToolCalls = 1;
      return stream(toolCallChunks(model, "bash", { command: "seq 1 30000" }));
    }

    if (seen.emittedToolCalls === 1) {
      const transcript = messages
        .filter((message) => message.role === "tool")
        .map((message) =>
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content ?? ""),
        )
        .join("\n");
      /**
       * 3. **在工具已经跑完之后**把流掐断 —— 这是"重发"最危险的位置：
       * 一旦重发是"从头再来"而不是"接着发"，已经产生的副作用（这里是跑过的命令）
       * 就会重做一遍，上下文里的工具结果也会丢。
       */
      if (seen.brokenStreams === 0) {
        seen.brokenStreams += 1;
        seen.awaitingRetry = true;
        return stream(brokenStreamChunks(model));
      }
      // 4. 重发请求：先确认它**还带着刚才那条工具结果**（证明是 continue 而不是重开）。
      if (seen.awaitingRetry) {
        seen.awaitingRetry = false;
        seen.retryKeptToolResult = transcript.includes("输出被截断");
        // 顺带确认任务陈述没有被重复一遍：重开一轮（重新 prompt）会让上下文里出现两条同样的任务。
        seen.retryTaskRepeats = messages.filter(
          (message) =>
            message.role === "user" &&
            JSON.stringify(message.content ?? "").includes("resilience-task"),
        ).length;
      }
      // 5. 空回合：服务端给一个空消息。
      if (seen.emptyTurns === 0) {
        seen.emptyTurns += 1;
        return stream([sseChunk(model, { role: "assistant", content: "" }, "stop")]);
      }
      // 6. 转存提示里的路径要能被模型用起来：从工具结果里把路径抄出来，分页读尾部。
      const spillPath = /完整输出已经存到 (\S+?)，/.exec(transcript)?.[1];
      if (!spillPath) {
        return stream(textChunks(model, "（工具结果里没有转存路径，说明截断提示不完整）"));
      }
      seen.readBackPath = spillPath;
      seen.emittedToolCalls = 2;
      return stream(
        toolCallChunks(model, "read_file", { path: spillPath, offset: 29_990, limit: 20 }),
      );
    }

    if (seen.emittedToolCalls === 2) {
      // 7. 再跑一条输出巨大的命令（head 读日志文件 a，210k 字符）：单条顶不穿窗口（上限是窗口的 25%），
      //    但与前面的 seq / read_file 叠加后就把预算顶穿了（第 7 节压缩断言依赖这条累积）。
      //    用 `head -c`（普通命令，走 stub 的 chat/completions 一个端点），不额外请求 stub。
      seen.emittedToolCalls = 3;
      seen.headLines.push(210000);
      return stream(
        toolCallChunks(model, "bash", {
          command: "head -c 210000 logs/a.log",
        }),
      );
    }

    if (seen.emittedToolCalls === 3) {
      // 8. 再来一条大输出（不同的命令与不同的文件，120k 字符）：
      //    累积继续增长，这一步之后的下一次请求会把预算顶穿、触发压缩。
      seen.emittedToolCalls = 4;
      seen.headLines.push(120000);
      return stream(
        toolCallChunks(model, "bash", {
          command: "head -c 120000 logs/b.log",
        }),
      );
    }

    if (seen.emittedToolCalls === 4) {
      // 9. 派一个只读子智能体（它自己会遇到空回合并被提醒）。
      seen.emittedToolCalls = 5;
      return stream(
        toolCallChunks(model, "task", {
          description: "确认报告该写在哪",
          prompt: "列一下工作区里有哪些文件，然后用一句话说报告该写去哪里。",
          subagent_type: "explore",
        }),
      );
    }

    if (seen.emittedToolCalls === 5) {
      // 10. 把报告写进工作区（产出物面板据此登记）。
      seen.emittedToolCalls = 6;
      return stream(
        toolCallChunks(model, "write_file", {
          path: "reports/log-report.md",
          content:
            "# 日志统计报告\n\n- 总行数：30000（尾部已从转存文件核对）\n- 数据来源：`seq 1 30000`\n",
        }),
      );
    }

    // 11. 收尾。
    return stream(
      textChunks(
        model,
        "报告写完了：reports/log-report.md，数据来自 `seq 1 30000` 的完整输出（已核对到第 30000 行）。",
      ),
    );
  },
});

const base = `http://127.0.0.1:${stub.port}/v1`;

// head 的数据源（写盘，`head -c` 是普通命令）：3500 / 2000 行 × 60 字符
// ≈ 210k / 120k 字节 —— 远超一条工具结果的上限（8k 窗口下 6144 字符）。
mkdirSync(path.join(workspace, "logs"), { recursive: true });
writeFileSync(path.join(workspace, "logs", "a.log"), longLines(3500));
writeFileSync(path.join(workspace, "logs", "b.log"), longLines(2000));

// ---------------------------------------------------------------------------
// 准备设置并跑这一条任务
// ---------------------------------------------------------------------------
const { updateSettings } = await import("../src/bun/db/settings");
const Chat = await import("../src/bun/chat");
const Agent = await import("../src/bun/agent");
const Artifacts = await import("../src/bun/agent-artifacts");

updateSettings({
  SETUP_COMPLETE: "1",
  SERVER_MODE: "remote",
  VLLM_API_BASE: base,
  VLLM_API_KEY: "EMPTY",
  // 云端模式下窗口跟着模型 id 走（chat-context.ts）：`-8k` 后缀把窗口钉在 8192，
  // 第 7 节“多条大输出累积把 8k 窗口顶穿”的压缩断言依赖这个数字。
  // （单条顶不穿：一条工具结果的上限是窗口的 25%，随窗口等比缩放，调小窗口没用。）
  VLLM_MODEL_NAME: "stub-model-8k",
  CHAT_MODEL: "stub-model-8k",
  SERVER_CTX_SIZE: "8192",
  /** auto：这条任务不该被授权弹窗打断（授权链路由 live-check 专门验）。 */
  AGENT_APPROVAL_MODE: "auto",
  // 步数上限提到 20：压缩场景需要“多条大输出累积”（3 条 bash + read_file + task + write_file）
  // + 503/空回合/重发的重试余量，12 步不够。
  AGENT_MAX_STEPS: "20",
  MEMORY_ENABLED: "0",
  AGENT_RETRY_MAX: "2",
  // 压缩保持默认的 summary：这条任务本来就会把窗口顶穿，摘要路径要被真的走到。
  AGENT_COMPACT_MODE: "summary",
});

let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — ${detail ?? ""}`}`);
  if (!ok) failed++;
};

/**
 * 校验器自检：一个永远返回 null 的"协议校验"等于没有断言。
 * 这里喂三种真实会出现的残局，确认它真的能抓到（否则下面那条"零违规"是假绿）。
 */
{
  const orphan = [
    { role: "user" },
    { role: "assistant", tool_calls: [{ id: "c1" }] },
    { role: "tool", tool_call_id: "c9" },
  ];
  const dangling = [{ role: "user" }, { role: "assistant", tool_calls: [{ id: "c1" }] }];
  const interrupted = [{ role: "assistant", tool_calls: [{ id: "c1" }] }, { role: "user" }];
  const healthy = [
    { role: "user" },
    { role: "assistant", tool_calls: [{ id: "c1" }] },
    { role: "tool", tool_call_id: "c1" },
  ];
  check(
    "协议校验器自检：孤儿结果 / 未结算调用 / 中间插入都能抓到，合法请求不误报",
    protocolViolation(orphan) !== null &&
      protocolViolation(dangling) !== null &&
      protocolViolation(interrupted) !== null &&
      protocolViolation(healthy) === null,
    JSON.stringify([
      protocolViolation(orphan),
      protocolViolation(dangling),
      protocolViolation(interrupted),
    ]),
  );
}

const conversation = Chat.createConversation("resilience task", "agent");
Agent.setConversationWorkspace(conversation.id, workspace);

/** 逐 token 收到的正文（用来验证"重发把半截旧文本收回去了"）。 */
const streamed = { content: "" };
const unsubscribe = Agent.onAgentChunk((payload) => {
  if (payload.conversationId !== conversation.id) return;
  if (payload.kind !== "reasoning") streamed.content += payload.delta;
});

console.log(`推理服务：${base}（内置桩），窗口 8192，自愈预算 2\n`);
const turn = await Agent.runAgentTurn({
  conversationId: conversation.id,
  content: "resilience-task：统计一下这批日志（输出很长），写份报告到 reports/ 下。",
  mode: "agent",
  workspace,
});
unsubscribe();

const events = Agent.listAgentEvents(conversation.id);
console.log(
  "· 轨迹：",
  events
    .map(
      (event) =>
        `${event.kind}:${event.toolName ?? ""}${event.subagentId ? `@${event.subagentId}` : ""}`,
    )
    .join(" → "),
  "\n",
);
const history = Chat.getHistory(conversation.id);
const lastAssistant = [...history].reverse().find((message) => message.role === "assistant");
const finalText = lastAssistant?.content ?? "";
const toolStarts = (name: string) =>
  events.filter((event) => event.kind === "tool_start" && event.toolName === name).length;
const statusMatching = (needle: string) =>
  events
    .filter((event) => (event.output ?? "").includes(needle))
    .map((event) => event.output ?? "");

// ---------------------------------------------------------------------------
// 1. 整条任务跑通（自愈不该以"放弃"结尾）
// ---------------------------------------------------------------------------
check("复杂任务整体跑完（returned ok）", turn.ok, turn.error);
check(
  "最终回答是收尾那一句（不是错误、不是空）",
  finalText.includes("报告写完了"),
  finalText.slice(0, 200),
);

// ---------------------------------------------------------------------------
// 2. 四道自愈都在同一条任务里发生过
// ---------------------------------------------------------------------------
check("传输层：桩服务确实打回过 2 次 503", seen.unavailable503 === 2, String(seen.unavailable503));
check("回合层：桩服务确实掐断过一次流", seen.brokenStreams === 1, String(seen.brokenStreams));
check(
  "回合层：轨迹里留下了自动重试（用户不必重发）",
  statusMatching("次自动重试").length === 1,
  JSON.stringify(statusMatching("自动重试")),
);
check(
  "空回合：主 Agent 被提醒过一次",
  seen.emptyTurns === 1 && statusMatching("已提醒它继续").length >= 1,
);
check(
  "子智能体：也被空回合提醒过（它的失败在主线上最难查）",
  seen.subagentRequests >= 2 &&
    events.some((event) => event.subagentId && (event.output ?? "").includes("已提醒它继续")),
  `子智能体请求 ${seen.subagentRequests} 次`,
);

// ---------------------------------------------------------------------------
// 3. 重发不重复副作用：已经跑成功的工具不会因为重发再跑一遍
// ---------------------------------------------------------------------------
check(
  "重发没有重跑已经成功的工具（seq 命令只执行了 1 次）",
  toolStarts("bash") === 3 && seen.headLines.length === 2,
  `bash tool_start = ${toolStarts("bash")}（期望 3：seq × 1 + head × 2），headLines = ${seen.headLines.length}（期望 2）`,
);
check(
  "重发是「接着发」而不是重开一轮：请求里仍然带着刚跑完的那条工具结果",
  seen.retryKeptToolResult,
  "重发请求里没有工具结果 —— 说明它被重开了（副作用会重做、上下文会丢）",
);
check(
  "重发没有把任务陈述重复一遍（上下文里只有一条任务，不是两条）",
  seen.retryTaskRepeats === 1,
  `任务陈述出现 ${seen.retryTaskRepeats} 次`,
);
check(
  "建会话的历史回填没有把本轮提问重复一遍（首轮请求里任务只出现一次）",
  seen.firstRequestTaskRepeats === 1,
  `首轮请求里任务陈述出现 ${seen.firstRequestTaskRepeats} 次`,
);
check(
  "后续工具也都只执行了一次（read_file / task / write_file）",
  toolStarts("read_file") === 1 && toolStarts("task") === 1 && toolStarts("write_file") === 1,
  `read_file=${toolStarts("read_file")} task=${toolStarts("task")} write_file=${toolStarts("write_file")}`,
);
check(
  "没有 error 形态的轨迹事件（重试用尽才会留下）",
  !events.some((event) => event.kind === "error"),
  JSON.stringify(events.filter((e) => e.kind === "error").map((e) => e.output)),
);
check(
  "每一个发出去的请求都是合法的线上协议（压缩没有切出孤儿工具结果 / 未结算调用）",
  seen.protocolViolations.length === 0,
  JSON.stringify(seen.protocolViolations.slice(0, 3)),
);

// ---------------------------------------------------------------------------
// 4. 失败那轮的半截正文被收回，不会混进最终气泡
// ---------------------------------------------------------------------------
check(
  "被掐断那轮的半截正文没有留在最终回答里",
  !finalText.includes(BROKEN_PARTIAL_TEXT) && !streamed.content.includes(BROKEN_PARTIAL_TEXT),
  finalText.slice(0, 160),
);

// ---------------------------------------------------------------------------
// 5. 转存提示是可执行的：模型照着路径把原文读了回来
// ---------------------------------------------------------------------------
const bashEnd = events.find((event) => event.kind === "tool_end" && event.toolName === "bash");
const bashOutput = bashEnd?.output ?? "";
check(
  "大输出被截断并转存（提示里有路径）",
  bashOutput.includes("输出被截断") && Boolean(seen.readBackPath),
  bashOutput.slice(-200),
);
check(
  "转存文件真的落盘",
  Boolean(seen.readBackPath) && existsSync(seen.readBackPath!),
  seen.readBackPath ?? "(无)",
);
const readEnd = events.find((event) => event.kind === "tool_end" && event.toolName === "read_file");
check(
  "模型读回了被截断的尾部（看到第 30000 行）",
  (readEnd?.output ?? "").includes("30000"),
  (readEnd?.output ?? "").slice(0, 160),
);

// ---------------------------------------------------------------------------
// 6. 子智能体与产出物
// ---------------------------------------------------------------------------
const subagentEnd = events.find((event) => event.kind === "subagent_end");
check(
  "子智能体交回了结论（不是「无输出」）",
  (subagentEnd?.output ?? "").startsWith("完成："),
  subagentEnd?.output?.slice(0, 160),
);
check(
  "报告真的写进了工作区",
  existsSync(path.join(workspace, "reports", "log-report.md")),
  path.join(workspace, "reports", "log-report.md"),
);
check(
  "报告登记成了产出物",
  Artifacts.listArtifacts(conversation.id).some((item) => item.path.includes("log-report.md")),
  JSON.stringify(Artifacts.listArtifacts(conversation.id).map((item) => item.path)),
);

// ---------------------------------------------------------------------------
// 7. 上下文压缩确实在中途发生过（多条大输出累积把 8k 窗口顶穿）
// ---------------------------------------------------------------------------
check(
  "任务中途触发过上下文压缩（摘要或裁剪）",
  events.some((event) => event.toolName === "compact"),
  JSON.stringify(
    events.filter((event) => event.toolName === "compact").map((event) => event.output),
  ),
);
check("压缩之后任务仍然跑完（转存路径没被压掉）", Boolean(seen.readBackPath) && turn.ok);

// ---------------------------------------------------------------------------
// 8. harness 消息不落库：会话历史仍是 1 问 1 答
// ---------------------------------------------------------------------------
check(
  "会话历史里只有 1 条用户消息（提醒 / 重试没有落成假用户消息）",
  history.filter((message) => message.role === "user").length === 1,
  JSON.stringify(history.map((message) => message.role)),
);
check(
  "会话历史里只有 1 条助手消息（重试延长的是同一个气泡）",
  history.filter((message) => message.role === "assistant").length === 1,
  JSON.stringify(history.map((message) => message.role)),
);
check(
  "重试 / 提醒都留在了这条消息的轨迹里（回看能看懂它为什么多发了几次请求）",
  events.filter((event) => event.kind === "status").length >= 3,
  String(events.filter((event) => event.kind === "status").length),
);

console.log(`\n最终回答：${finalText.slice(0, 200)}\n`);

// ---------------------------------------------------------------------------
// 9. 裁剪的 400 保护：边界正好落在"工具结果"上时必须往前让一格
// ---------------------------------------------------------------------------
/**
 * 这一条必须用**真实形状的历史**来验，而不是只看上面那条"零违规"：
 * 裁剪的边界由每条消息的 token 数决定，本次任务恰好没让边界落在工具结果上
 * （摘要路径会先把前缀摘掉，剩下的是干净的用户消息边界）。
 * 所以这里直接对真实的 `compactMessages()` 喂一份"边界一定落在工具结果上"的历史 ——
 * 这类残局真实服务端就是 400，§6.3 记过它曾经因为角色名写错而整道失效。
 */
{
  const { compactMessages } = await import("../src/bun/agent-compaction");
  const big = (chars: number) => "x".repeat(chars);
  const history = [
    { role: "user", content: [{ type: "text", text: big(400) }] },
    { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }] },
    // 这一条很大：它会把裁剪边界推到"工具结果"上（预算再小也删不掉它，因为至少保留 4 条）。
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "bash",
      content: [{ type: "text", text: big(4000) }],
    },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "c2", name: "read_file", arguments: {} }],
    },
    {
      role: "toolResult",
      toolCallId: "c2",
      toolName: "read_file",
      content: [{ type: "text", text: "小" }],
    },
    { role: "assistant", content: [{ type: "text", text: "下一步" }] },
  ];
  const trimmed = compactMessages(history as never[], 50, (dropped: number) => ({
    role: "user",
    content: [{ type: "text", text: `（省略 ${dropped} 条）` }],
  }));
  const violation = protocolViolation(toWireShape(trimmed.messages as never[]));
  check(
    "裁剪后的历史仍然合法（没有留下孤儿工具结果）",
    trimmed.dropped > 0 && violation === null,
    `dropped=${trimmed.dropped} · ${violation ?? ""}`,
  );
  check(
    "自检：这份历史确实会让边界落在工具结果上（否则上面的检查是空跑）",
    trimmed.messages.some((message) => (message as { role?: string }).role === "toolResult"),
    JSON.stringify(trimmed.messages.map((message) => (message as { role?: string }).role)),
  );
}

// ---------------------------------------------------------------------------
// 清理
// ---------------------------------------------------------------------------
Agent.deleteConversationEvents(conversation.id);
Agent.stopAgentRun(conversation.id);
stub.stop();
rmSync(dataDir, { recursive: true, force: true });
rmSync(workspace, { recursive: true, force: true });

if (failed > 0) {
  console.error(`resilience smoke: ${failed} 项失败`);
  process.exit(1);
}
console.log("resilience smoke 全部通过");
