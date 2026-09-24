/**
 * `runAgentTurn` 的启动窗口停止（`stopRequests`）。
 *
 * 缺陷：用户在启动期（本地模式下拉起推理服务、建会话的几十秒窗口，界面正显示
 * 「处理中」）按下停止。`stopAgentRun` 记下标记后 `runAgentTurn` 从 await 里醒来，
 * 把标记删掉（原代码在第二处 await 之后才清），回合当作什么都没发生，照常发出
 * 第一次请求 —— 用户按了停止，模型照样跑。
 *
 * 期望语义：
 * 1. 清除挪到同步段（第一处 await 之前）：只清上一轮残留，不清本窗口新按的停止；
 * 2. 启动期按下的停止能拦住第一次请求（会话建好后补一刀 abort，
 *    `agent.prompt()` 抛中止错误，走已有的「已停止」收尾路径）。
 *
 * 关键断言是**桩服务收到几次 chat completions 请求** —— 这是唯一能证明
 * 「请求真的没发出去」的硬指标（桩的 `respond` 每次收到请求都被调用）。
 *
 * 命中启动窗口的方式：`runAgentTurn` 返回 Promise 但**不 await**，紧接着
 * **同一个微任务**里调 `stopAgentRun` —— 此时会话还没建出来（`sessions` 里没有
 * 这个 conversationId），`stopAgentRun` 记下标记后返回 `ok: false`。
 */
import { describe, expect, test } from "bun:test";

import * as Chat from "./chat";
import * as Agent from "./agent";
import { startStubLlm, textChunks, type StubLlm } from "./test-stub-llm";
import { updateSettings } from "./db/settings";

function configure(stub: StubLlm): void {
  updateSettings({
    SETUP_COMPLETE: "1",
    SERVER_MODE: "remote",
    VLLM_API_BASE: stub.base,
    VLLM_API_KEY: "EMPTY",
    VLLM_MODEL_NAME: "stub-model",
    CHAT_MODEL: "stub-model",
    AGENT_APPROVAL_MODE: "auto",
    AGENT_RETRY_MAX: "1",
  });
}

/**
 * 持续 500 的桩：每次 chat completions 请求都失败（含 "Internal server error"
 * 字样，pi-ai 据此判定可重试）。`AGENT_RETRY_MAX=1` 让传输层 + 回合层各重试一次。
 * 桩侧的 `calls()` 是「请求真的发出去了」的硬指标。
 */
function startFailingStub(): { stub: StubLlm; calls: () => number } {
  let count = 0;
  const stub = startStubLlm({
    respond: () => {
      count += 1;
      return new Response(
        JSON.stringify({ error: { message: "Internal server error", type: "server_error" } }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    },
  });
  return { stub, calls: () => count };
}

function startSuccessStub(): { stub: StubLlm; calls: () => number } {
  let count = 0;
  const stub = startStubLlm({
    respond: (request) => {
      count += 1;
      return textChunks(request.model, "一切正常，任务已完成。");
    },
  });
  return { stub, calls: () => count };
}

describe("runAgentTurn 启动窗口的停止（stopRequests）", () => {
  test("启动期按停止 → 桩一次请求都没收到，回合走「已停止」收尾", async () => {
    const { stub, calls } = startFailingStub();
    try {
      configure(stub);
      const conversation = Chat.createConversation("启动期停止", "agent");

      // 命中启动窗口：runAgentTurn 返回 Promise 但**不 await**，同一个微任务里
      // 紧接着调 stopAgentRun —— 此时会话还没建出来（`sessions` 里没有这个
      // conversationId），stopAgentRun 记下标记后返回 ok: false。
      // 原代码：标记在第二处 await 之后被清掉，回合照常发第一次请求（桩被调用 1+ 次）。
      // 修复后：标记在同步段被保留，makeContextTransform 抛出 aborted 错误，第一次请求发不出去。
      const first = Agent.runAgentTurn({
        conversationId: conversation.id,
        content: "stop-startup：跑一下。",
        mode: "agent",
      });
      Agent.stopAgentRun(conversation.id);

      const turn = await first;
      // 硬指标：修复前桩被调用 1+ 次（请求真的发出去了）；修复后 0 次。
      expect(calls()).toBe(0);
      // 「已停止」收尾路径（makeContextTransform 抛出 aborted 错误 → catch 里 /abort/i 判定）：
      // turn.ok 是 true（用户主动按停止不是错误），但助手消息里带「已停止」。
      expect(turn.ok).toBe(true);
      const lastAssistant = [...Chat.getHistory(conversation.id)]
        .reverse()
        .find((message) => message.role === "assistant");
      expect(lastAssistant?.content ?? "").toContain("已停止");
    } finally {
      stub.stop();
    }
  });

  test("上一轮的残留标记不拖累下一轮：先按停止（不跑回合），再正常跑完", async () => {
    const { stub, calls } = startSuccessStub();
    try {
      configure(stub);
      const conversation = Chat.createConversation("残留标记", "agent");

      // 会话还没建过：stopAgentRun 记下标记后因为没有 abort 目标返回 ok: false，
      // 标记会留在集合里 —— 下一轮开始时必须被清掉，不能拦住新回合。
      // 原代码：标记在第二处 await 之后被清掉，新回合正常完成（这条在修复前后都绿）。
      // 修复后：标记在同步段（第一处 await 之前）被清掉，新回合同样正常完成。
      Agent.stopAgentRun(conversation.id);

      const turn = await Agent.runAgentTurn({
        conversationId: conversation.id,
        content: "stale-stop：跑一下。",
        mode: "agent",
      });
      expect(turn.ok).toBe(true);
      // 桩被调用 1 次 = 新回合确实发了一次请求（没被残留标记拦住）。
      expect(calls()).toBe(1);
    } finally {
      stub.stop();
    }
  });

  test("跑完之后运行态回落：isAgentRunning 为 false", async () => {
    const { stub } = startSuccessStub();
    try {
      configure(stub);
      const conversation = Chat.createConversation("运行态回落", "agent");

      // 正常回合跑完后，running / starting 都该清掉（04a 的危险：漏清则永久显示在跑）。
      const turn = await Agent.runAgentTurn({
        conversationId: conversation.id,
        content: "cleanup：跑一下。",
        mode: "agent",
      });
      expect(turn.ok).toBe(true);
      expect(Agent.isAgentRunning(conversation.id)).toBe(false);
    } finally {
      stub.stop();
    }
  });

  test("两轮之间按停止也拦得住：退避期间按停止，桩收到的请求次数不再增长", async () => {
    const { stub, calls } = startFailingStub();
    try {
      configure(stub);
      const conversation = Chat.createConversation("两轮之间停止", "agent");

      // 回合1：正常跑（桩 500，重试 1 次，最终失败）。桩收到 4 次请求（传输层 2 + 回合层 2）。
      const t1 = await Agent.runAgentTurn({
        conversationId: conversation.id,
        content: "between-turns：跑一下。",
        mode: "agent",
      });
      expect(t1.ok).toBe(false);
      const reqsAfterT1 = calls();
      expect(reqsAfterT1).toBeGreaterThan(0);

      // 回合2：微任务 stop（会话已存在，abort no-op + 标记残留）。
      // makeContextTransform 在第一次模型调用前检查 stopRequests，抛出 aborted 错误。
      // 桩收到的请求次数应该不再增长（delta = 0）。
      const t2 = Agent.runAgentTurn({
        conversationId: conversation.id,
        content: "between-turns：第二句。",
        mode: "agent",
      });
      Agent.stopAgentRun(conversation.id);
      const t2result = await t2;
      const reqsAfterT2 = calls();

      // 硬指标：回合2 没有发出任何新请求（makeContextTransform 拦住了）。
      expect(reqsAfterT2 - reqsAfterT1).toBe(0);
      // 回合2 走「已停止」收尾（turn.ok 是 true，助手消息里带「已停止」）。
      expect(t2result.ok).toBe(true);
      const lastAssistant = [...Chat.getHistory(conversation.id)]
        .reverse()
        .find((message) => message.role === "assistant");
      expect(lastAssistant?.content ?? "").toContain("已停止");
      expect(Agent.isAgentRunning(conversation.id)).toBe(false);
    } finally {
      stub.stop();
    }
  });
});
