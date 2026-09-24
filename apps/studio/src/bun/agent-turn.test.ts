/**
 * `runAgentTurn` 收尾返回值：失败回合必须返回 `ok: false` 并带上原因。
 *
 * 已发生的问题：`outcome.kind === "error"`（模型持续报错、重试耗尽）时界面会看到
 * ⚠️ 一行，但函数返回给调用方的是 `ok: true` —— 无头执行（`omi agent run`、
 * 自动化）据此报告成功、退出码 0，脚本串 `&&` 会带着一份失败结果继续往下走。
 *
 * 这是第一个用脚本化桩服务（`test-stub-llm.ts`）真跑一个回合的单测：
 * 桩对 chat completions 持续回 500（含 "Internal server error" 字样，
 * pi-ai 据此判定可重试），`AGENT_RETRY_MAX=1` 让传输层 + 回合层各重试一次，
 * 预算用尽后这一轮以 `error` 收尾 —— 正是我们要观察的形态。
 */
import { describe, expect, test } from "bun:test";

import * as Chat from "./chat";
import * as Agent from "./agent";
import { startStubLlm, textChunks, type StubLlm } from "./test-stub-llm";
import { updateSettings } from "./db/settings";

/**
 * 桩持续 500：可重试，重试耗尽后这一轮以 error 收尾。
 * 每次请求发一份新的 Response（同一份 Response 只能被送一次，重试会二次消费 body）。
 */
function serverError(): Response {
  return new Response(
    JSON.stringify({ error: { message: "Internal server error", type: "server_error" } }),
    { status: 500, headers: { "content-type": "application/json" } },
  );
}

function startFailingStub(): StubLlm {
  return startStubLlm({ respond: () => serverError() });
}

function startSuccessStub(): StubLlm {
  return startStubLlm({ respond: (request) => textChunks(request.model, "一切正常，任务已完成。") });
}

/**
 * 前置检查（runAgentTurn 开头几道）与回合内失败都返回 `ok: false`：
 * 只断言 `ok: false` 会造出"被前置检查挡回来"的假绿，所以这里额外断言
 * 错误文本必须来自桩（"Internal server error"），证明真的走到了模型请求。
 */
async function runFailingTurn(): Promise<{ ok: boolean; error?: string }> {
  const stub = startFailingStub();
  try {
    updateSettings({
      SETUP_COMPLETE: "1",
      SERVER_MODE: "remote",
      VLLM_API_BASE: stub.base,
      VLLM_API_KEY: "EMPTY",
      VLLM_MODEL_NAME: "stub-model",
      CHAT_MODEL: "stub-model",
      AGENT_APPROVAL_MODE: "auto",
      // 传输层 + 回合层各重试 1 次，失败来得快（总退避约 1.2s），不让用例拖长。
      AGENT_RETRY_MAX: "1",
    });
    const conversation = Chat.createConversation("失败回合", "agent");
    return await Agent.runAgentTurn({
      conversationId: conversation.id,
      content: "turn-failure：跑一下。",
      mode: "agent",
    });
  } finally {
    stub.stop();
  }
}

async function runSuccessTurn(): Promise<{ ok: boolean; error?: string }> {
  const stub = startSuccessStub();
  try {
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
    const conversation = Chat.createConversation("成功回合", "agent");
    return await Agent.runAgentTurn({
      conversationId: conversation.id,
      content: "turn-success：跑一下。",
      mode: "agent",
    });
  } finally {
    stub.stop();
  }
}

describe("runAgentTurn 收尾返回值", () => {
  test("模型持续报错时返回 ok: false 且带上原因", async () => {
    const turn = await runFailingTurn();
    expect(turn.ok).toBe(false);
    expect(turn.error).toBeTruthy();
    expect(turn.error ?? "").toContain("Internal server error");
  });

  test("正常成功的回合仍返回 ok: true", async () => {
    const turn = await runSuccessTurn();
    expect(turn.ok).toBe(true);
    expect(turn.error).toBeUndefined();
  });

  test("失败那一轮轨迹里仍有 error 事件，正文仍带 ⚠️（原有可见行为没动）", async () => {
    const stub = startFailingStub();
    try {
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
      const conversation = Chat.createConversation("失败回合轨迹", "agent");
      const turn = await Agent.runAgentTurn({
        conversationId: conversation.id,
        content: "turn-failure-trace：跑一下。",
        mode: "agent",
      });
      expect(turn.ok).toBe(false);

      const events = Agent.listAgentEvents(conversation.id);
      const errorEventTexts = events
        .filter((event) => event.kind === "error")
        .map((event) => event.output ?? "");
      expect(errorEventTexts.length).toBeGreaterThan(0);
      expect(errorEventTexts.some((text) => text.trim().length > 0)).toBe(true);

      const lastAssistant = [...Chat.getHistory(conversation.id)]
        .reverse()
        .find((message) => message.role === "assistant");
      expect(lastAssistant?.content ?? "").toContain("⚠️");
    } finally {
      stub.stop();
    }
  });
});
