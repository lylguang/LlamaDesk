/**
 * `stopAllAgentRuns`：应用退出时的 agent 收尾入口。
 *
 * 已发生的问题：`shutdown.ts` 的收尾链收了推理服务、语音、OCR、网关、隧道、
 * 侧栏终端、技能、控制服务，唯独没收 agent。agent 的 `bash` 工具是**独立进程组**
 * （`agent-tools.ts` 里 `detached: true`），父进程直接退出后它们变成孤儿继续跑
 * （`seq`、`npm install`、测试套件都可能跑很久）；回合正文只在收尾时才落库，
 * 进程直接退出等于这一轮已经生成的正文整段丢失；挂起的授权弹窗、排队消息也没收。
 *
 * 修好后：收尾链调 `stopAllAgentRuns()` —— 对 `running` 与 `starting` 里每个会话
 * 各调一次现成的 `stopAgentRun`（请求停止），具体的中止 / 正文落库 / 进程组回收
 * 由各回合自己的收尾路径完成。这个函数必须是**同步**的：同步版收尾
 * （`teardownServicesSync`，SIGTERM 之类不能等 Promise 的路径）也要用它。
 *
 * 卡住回合的方式（不赌 sleep）：桩的 respond 挂在闸门上，第一个请求一直挂着
 * （回合停在等模型响应），其余请求立即回话。stop 后闸门放行，
 * 已被标记停止的回合被 abort、走完 finally 收尾。
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
 * 挂闸门的桩：收到的**第一个** chat completions 请求一直挂着（回合停在
 * 等模型响应），其余请求立刻回话。`openGate()` 放行第一个请求，
 * 已被 `stopAllAgentRuns` 标记停止的回合应被 abort、走收尾。
 */
function startGatedStub(): { stub: StubLlm; openGate: () => void } {
  let gateResolve: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    gateResolve = resolve;
  });
  let first = true;
  const stub = startStubLlm({
    async respond(request) {
      if (first) {
        first = false;
        await gate;
      }
      return textChunks(request.model, "收尾后的答复");
    },
  });
  return { stub, openGate: () => gateResolve() };
}

/**
 * 起一个卡住的 agent 回合：`runAgentTurn` 不 await，微任务排到第一处 await
 * 返回之后才调用 `stopAllAgentRuns()` —— 此时会话必然已过了启动窗口
 * （`starting` 已清、`running` 已置上），回合停在闸门后的模型请求上。
 */
async function startStuckTurn(
  stub: StubLlm,
  title: string,
): Promise<{ stopped: number; turn: Promise<{ ok: boolean; error?: string }>; conversationId: number }> {
  configure(stub);
  const conversation = Chat.createConversation(title, "agent");
  const turn = Agent.runAgentTurn({
    conversationId: conversation.id,
    content: "shutdown：跑一下。",
    mode: "agent",
  });
  // 等启动段过完：会话从 starting 挪进 running（桩不返回，回合就停在这里）。
  for (let i = 0; i < 500; i++) {
    if (Agent.isAgentRunning(conversation.id)) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  const stopped = Agent.stopAllAgentRuns();
  return { stopped, turn, conversationId: conversation.id };
}

describe("stopAllAgentRuns（应用退出时收尾 agent）", () => {
  test("有回合在跑时返回被停的会话数，之后运行态回落", async () => {
    const { stub, openGate } = startGatedStub();
    try {
      const { stopped, turn, conversationId } = await startStuckTurn(stub, "退出收尾");
      // 函数是同步的：直接调、不 await。
      expect(typeof stopped).toBe("number");
      expect(stopped).toBeGreaterThanOrEqual(1);
      openGate();
      await turn;
      expect(Agent.isAgentRunning(conversationId)).toBe(false);
    } finally {
      stub.stop();
    }
  });

  test("没有回合在跑时返回 0 且不抛错", () => {
    const stopped = Agent.stopAllAgentRuns();
    expect(stopped).toBe(0);
  });

  test("多个会话同时在跑时都被停，返回值为会话数", async () => {
    const { stub, openGate } = startGatedStub();
    try {
      // 两个回合都停在 running 里：桩只卡第一个请求，第二个立即回话，
      // 所以两轮先后停在各自的模型请求上；第一次 stopAllAgentRuns
      // 把第一个回合标记停止（其请求仍在闸门后排队），第二个此刻仍在跑。
      const a = await startStuckTurn(stub, "多会话一");
      expect(Agent.isAgentRunning(a.conversationId)).toBe(true);
      const b = await startStuckTurn(stub, "多会话二");
      expect(Agent.isAgentRunning(b.conversationId)).toBe(true);
      const stopped = Agent.stopAllAgentRuns();
      expect(stopped).toBe(2);
      openGate();
      const [turnA, turnB] = await Promise.all([a.turn, b.turn]);
      expect(turnA.ok).toBe(true);
      expect(turnB.ok).toBe(true);
      expect(Agent.isAgentRunning(a.conversationId)).toBe(false);
      expect(Agent.isAgentRunning(b.conversationId)).toBe(false);
    } finally {
      stub.stop();
    }
  });
});
