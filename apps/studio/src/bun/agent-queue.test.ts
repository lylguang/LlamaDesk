/**
 * `followUpAgentMessage` 的 queue 分支：运行中排进来的那条用户消息
 * 只应该落库一次。
 *
 * 已发生的问题：入队时 `followUpAgentMessage` 先把消息写进库（实时上下文要看到它），
 * 本次运行结束后 `drainQueuedMessages` 再逐条跑回合 —— 而 `runAgentTurn` 默认会
 * 再插一条同样的用户消息。结果：会话里出现两个一模一样的用户气泡，
 * 模型在历史与本轮提问里各看到它一遍。同一文件里「重新生成」那条路径
 * 已经踩过并修好（`insertUserMessage: false`），排队路径漏了。
 *
 * 桩推理服务（`test-stub-llm.ts`）真跑回合：第一轮应答前等一个由桩控制的
 * 闸门，闸门打开前调 `followUpAgentMessage`（保证第一轮还在跑、走 queue 分支），
 * 闸门打开后两轮依次结束。不靠固定 sleep 赌时序：
 * - 跟进前等 `isAgentRunning` 变 true（回合在起会话之后才登记运行态，直接
 *   fire-and-forget 调用时它还没置位）；
 * - 第一轮 resolve 后等 `isAgentRunning` 变 false —— 排队轮是在收尾处
 *   fire-and-forget 的（void drainQueuedMessages），「还在跑」说明它一定
 *   已经开跑，不必赌它的结束时机。
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
 * 起一个「按轮次应答」的桩：
 * - 第 1 次 chat completions 请求先等 `gate` resolve（第一轮因此挂住、仍在跑），
 *   随后回「第一轮的答复」；
 * - 第 2 次及以后（排队那一轮）直接回「排队轮的答复」。
 * 两个答复用不同的措辞，用例据此证明第二轮真的发过请求（不是「排队根本没跑」
 * 造成的假绿）。
 */
function startGateStub(): { stub: StubLlm; openGate: () => void } {
  let gateResolve: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    gateResolve = resolve;
  });
  let calls = 0;
  const stub = startStubLlm({
    async respond(request) {
      calls += 1;
      if (calls === 1) {
        await gate;
        return textChunks(request.model, "第一轮的答复");
      }
      return textChunks(request.model, "排队轮的答复");
    },
  });
  return { stub, openGate: () => gateResolve() };
}

/** 等一个布尔条件成立（10ms 一拍，上限 10s）。超时不 sleep 硬等，直接抛错。 */
async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000; i += 1) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待超时：${what}`);
}

/**
 * 第一轮不等它结束就发跟进消息：`runAgentTurn` 返回 Promise，先不 await，
 * 等它登记为运行中（`isAgentRunning`）后再调 `followUpAgentMessage` ——
 * 闸门保证此刻第一轮仍在跑，跟进消息走 queue 分支（`queued: true`）而不是
 * 「没在跑、直接再跑一轮」分支。
 */
async function runQueuedScenario() {
  const { stub, openGate } = startGateStub();
  try {
    configure(stub);
    const conversation = Chat.createConversation("排队消息", "agent");
    const first = Agent.runAgentTurn({
      conversationId: conversation.id,
      content: "第一条：跑一下。",
      mode: "agent",
    });
    await waitFor(() => Agent.isAgentRunning(conversation.id), "第一轮进入运行态");
    const followUp = await Agent.followUpAgentMessage({
      conversationId: conversation.id,
      content: "第二条",
      mode: "queue",
    });
    expect(followUp.queued).toBe(true);
    openGate();
    const result = await first;
    // 排队轮由回合收尾处 fire-and-forget 启动，第一轮 resolve 时它可能还没开始。
    // 只等「历史里出现排队轮的答复」这一个判据（10ms 一拍）：它出现 = 排队轮
    // 真的发过请求且正常答完；若排队轮根本没启动，这里会超时抛错，用例变红。
    await waitFor(
      () =>
        Chat.getHistory(conversation.id).some((m) =>
          (m.content ?? "").includes("排队轮的答复"),
        ),
      "排队轮的答复出现",
    );
    return { conversation, followUp, result };
  } finally {
    stub.stop();
  }
}

describe("运行中排队的用户消息", () => {
  test("库里只有一条，且排队那一轮真的跑起来了", async () => {
    const { conversation, followUp, result } = await runQueuedScenario();

    // 跟进消息确实走的是排队分支（第一轮还在跑）。
    expect(followUp.ok).toBe(true);
    expect(followUp.queued).toBe(true);
    // 第一轮正常结束。
    expect(result.ok).toBe(true);

    const history = Chat.getHistory(conversation.id);
    const secondUser = history.filter((m) => m.role === "user" && m.content === "第二条");
    // 缺陷：入队插一次 + 出队跑回合又插一次 = 两条一模一样的用户气泡。
    expect(secondUser.length).toBe(1);

    // 防假绿：排队那一轮必须真的跑过 —— 两条助手回复，第二条是桩对
    // 第二次请求的应答（措辞与第一轮不同，证明它确实发了请求）。
    const assistants = history.filter((m) => m.role === "assistant");
    expect(assistants.length).toBe(2);
    expect(assistants[0]?.content).toContain("第一轮的答复");
    expect(assistants[1]?.content).toContain("排队轮的答复");
  });
});
