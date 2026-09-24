/**
 * `runAgentTurn` 的启动窗口重入：`setAgentRunning(true)` 之前有两处 await
 * （拉起推理服务、建会话），窗口内 `isAgentRunning` 若返回 false，
 * `followUpAgentMessage` 就会把「再发一条」当成「没在跑」直接起第二轮 ——
 * 两轮共用同一个 Agent 实例与同一批模块级状态。本地模式下这个窗口能长达
 * 几十秒（用户看到界面还没进入「运行中」就再按一次发送）。
 *
 * 命中窗口的方式（不赌 sleep）：`runAgentTurn` 返回 Promise 但**不 await**，
 * 紧接着**同一个微任务**里调 `followUpAgentMessage` —— 此时第一轮连第一处
 * await 都还没返回，启动窗口必然开着。桩让第一次模型请求挂在闸门上：
 * 修好前跟进会「没在跑、直接起第二轮」，于是产生第二次请求把闸门打开
 * （桩按调用次数放行，第二轮拿到答复并跑完，不会把进程挂住）；
 * 修好后跟进走排队分支，桩恰好只被请求一次。
 * 所以修好前这条用例**可复现地失败**（桩被请求两次），不是靠时序撞的。
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
 * 按轮次应答的桩：第 1 次 chat completions 请求先等闸门（第一轮因此停在
 * 等模型响应），第 2 次及以后直接回话。`calls` 暴露调用次数 ——
 * 「启动窗口里只该有一轮在跑」的桩侧证据就是它恰好等于 1。
 */
function startGateStub(): { stub: StubLlm; openGate: () => void; calls: () => number } {
  let gateResolve: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    gateResolve = resolve;
  });
  let count = 0;
  const stub = startStubLlm({
    async respond(request) {
      count += 1;
      if (count === 1) {
        await gate;
        return textChunks(request.model, "第一轮的答复");
      }
      return textChunks(request.model, "排队轮的答复");
    },
  });
  return { stub, openGate: () => gateResolve(), calls: () => count };
}

describe("runAgentTurn 启动窗口重入（starting 标记）", () => {
  test("启动窗口里再发消息会被排队，不会并发起第二轮", async () => {
    const { stub, openGate, calls } = startGateStub();
    try {
      configure(stub);
      const conversation = Chat.createConversation("启动窗口重入", "agent");

      // 关键时序：runAgentTurn 返回 Promise 但**不 await**，紧跟的同一个微任务
      // 里调 followUpAgentMessage —— 此时第一轮还没过第一处 await（拉起推理
      // 服务的检查 / 建会话），启动窗口必然开着。
      const first = Agent.runAgentTurn({
        conversationId: conversation.id,
        content: "reentry：第一句。",
        mode: "agent",
      });
      const follow = await Agent.followUpAgentMessage({
        conversationId: conversation.id,
        content: "reentry：第二句。",
        mode: "queue",
      });

      // 缺陷：窗口内 isAgentRunning 为 false → 跟进被当成「没在跑」直接跑了
      // 第二轮（queued: false）；修好后走排队分支（queued: true）。
      expect(follow.queued).toBe(true);

      openGate();
      const turn = await first;
      expect(turn.ok).toBe(true);
      // 桩侧证据：只被请求过一次 = 第二轮没有并发起来。
      // （修好前跟进会直接跑一轮 → 桩被请求第二次把闸门打开 → 这里是 2，红。）
      expect(calls()).toBe(1);
    } finally {
      stub.stop();
    }
  });

  test("回合正常收尾后，会话不再显示「在跑」", async () => {
    const { stub, openGate } = startGateStub();
    try {
      configure(stub);
      const conversation = Chat.createConversation("收尾回落", "agent");

      // 同样的「不 await + 同微任务跟进」时序：跟进先断言启动窗口被算进「在跑」，
      // 再放行让这一轮真正跑完 —— 专门验证 starting 占位在收尾时被清掉
      // （漏清的话它会永久留在集合里，输入框永久禁用）。
      const first = Agent.runAgentTurn({
        conversationId: conversation.id,
        content: "cleanup：跑一下。",
        mode: "agent",
      });
      const follow = await Agent.followUpAgentMessage({
        conversationId: conversation.id,
        content: "cleanup：第二句。",
        mode: "queue",
      });
      expect(follow.queued).toBe(true);
      expect(Agent.isAgentRunning(conversation.id)).toBe(true);

      openGate();
      const turn = await first;
      expect(turn.ok).toBe(true);
      // 排队轮是在收尾处 fire-and-forget 启动的（void drainQueuedMessages），第一轮
      // resolve 时它可能还没开始也可能已在跑。只等「排队轮的答复」出现（= 它跑完了）
      // 再断言 false —— 专门验证 starting / running 都在收尾时被清掉（漏清则永久为 true）。
      for (let i = 0; i < 500; i++) {
        if (Chat.getHistory(conversation.id).some((m) => (m.content ?? "").includes("排队轮的答复"))) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(Chat.getHistory(conversation.id).some((m) => (m.content ?? "").includes("排队轮的答复"))).toBe(true);
      expect(Agent.isAgentRunning(conversation.id)).toBe(false);
    } finally {
      stub.stop();
    }
  });
});
