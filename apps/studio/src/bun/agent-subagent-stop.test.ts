/**
 * 停止信号传不到子智能体（`task` 工具把内核给的 `signal` 丢了）。
 *
 * 缺陷：用户在主 Agent 派了 `task` 之后按下停止。04b 的修复
 * （`makeContextTransform` 在下次模型调用前抛中止错）只能拦住子智能体的
 * **下一次模型请求** —— 拦不住「这一轮已经决定要跑的工具」：子智能体正在
 * 跑 `bash` / `write_file` 时，那条命令照样执行到自然结束。
 *
 * 期望语义：把中止信号一路传到子智能体（`task.execute` → `spawnSubagent` →
 * `runSubagent` → 子 Agent 的 `abort()`），让它自己的工具执行也被打断。
 *
 * 桩脚本：主 Agent 第一次请求收到 `task` 工具调用 → 派子智能体；
 * 子智能体（系统提示以「你是 LlamaDesk 的子智能体」开头）第一次请求收到
 * `bash` 工具调用：先写「开始标记」，sleep 3s，再写「结束标记」。
 * 子智能体的 bash 一进入 sleep，主进程调 `stopAgentRun(conversationId)`。
 *
 * 硬证据（能区分「被打断」与「跑完了」）：
 * - 开始标记文件**存在**（bash 真的跑起来了）；
 * - 结束标记文件**不存在**（sleep 被中止，命令没有自然结束）。
 *
 * 回归保护：子智能体的请求次数在停止之后不再增长
 * （04b 的 `makeContextTransform` 兜住了「下一次模型请求」这一半）。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import * as Agent from "./agent";
import * as Chat from "./chat";
import { startStubLlm, textChunks, toolCallChunks } from "./test-stub-llm";
import { updateSettings } from "./db/settings";

/**
 * 子智能体执行的 bash：
 * 1. 写开始标记（immediate）；
 * 2. sleep 3s；
 * 3. 写结束标记（only if sleep completed）。
 *
 * 停止打断 sleep → 开始标记在、结束标记不在。
 * 如果命令自然跑完 → 两个标记都在。
 */
const SLEEP_MS = 3000;
const BASH_CMD = "echo start > .stop-test-start && sleep 3 && echo end > .stop-test-end";

/** 等待某个条件为真（最多 waitMs 毫秒），超时返回 false。 */
async function waitUntil(
  predicate: () => boolean,
  waitMs: number,
  intervalMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

describe("停止信号传到子智能体（task 工具）", () => {
  test("停止之后子智能体的 bash 被打断（结束标记不存在）", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "omni-subagent-stop-"));
    const startMarker = path.join(workspace, ".stop-test-start");
    const endMarker = path.join(workspace, ".stop-test-end");

    let subagentRequests = 0;
    const stub = startStubLlm({
      respond: async (request) => {
        const { model, messages } = request;
        const system = messages.find((message) => message.role === "system")?.content;
        const systemText = typeof system === "string" ? system : "";

        // 子智能体（系统提示以这句话开头）
        if (systemText.startsWith("你是 LlamaDesk 的子智能体")) {
          subagentRequests += 1;
          // 第一次：给 bash 工具调用
          if (subagentRequests === 1) {
            return toolCallChunks(model, "bash", { command: BASH_CMD });
          }
          // 第二次：给文本结论（正常结束）
          return textChunks(model, "子智能体已完成。");
        }

        // 主 Agent
        // 第一次请求：派子智能体
        const hasUserMsg = messages.some(
          (message) => message.role === "user" && JSON.stringify(message.content ?? "").includes("subagent-stop"),
        );
        if (hasUserMsg) {
          return toolCallChunks(model, "task", {
            description: "测试停止",
            prompt: "写一个标记文件并等 3 秒",
            subagent_type: "general",
          });
        }
        // 主 Agent 收到子智能体结论后收尾
        return textChunks(model, "主 Agent 收到子智能体结论，任务完成。");
      },
    });

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

      const conversation = Chat.createConversation("子智能体停止", "agent");

      // 不 await：让子智能体的 bash 有时间跑起来
      const turnPromise = Agent.runAgentTurn({
        conversationId: conversation.id,
        content: "subagent-stop：派一个子智能体跑 bash。",
        mode: "agent",
        workspace,
      });

      // 等待开始标记出现（证明 bash 已经跑起来了）
      const started = await waitUntil(() => existsSync(startMarker), SLEEP_MS + 5000);
      expect(started).toBe(true);

      // 停止：此时 bash 正在 sleep（3 秒）
      Agent.stopAgentRun(conversation.id);

      // 等 turn 结束
      const turn = await turnPromise;

      // 硬证据：
      // 1. 开始标记在（bash 真的跑起来了）
      expect(existsSync(startMarker)).toBe(true);
      // 2. 结束标记不在（sleep 被中止，命令没有自然结束）
      //    如果不传 signal，bash 会跑完 3s sleep，结束标记就会出现。
      expect(existsSync(endMarker)).toBe(false);
    } finally {
      stub.stop();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("停止之后子智能体不再发起新的模型请求（04b 回归保护）", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "omni-subagent-stop2-"));

    let subagentRequests = 0;
    const stub = startStubLlm({
      respond: async (request) => {
        const { model, messages } = request;
        const system = messages.find((message) => message.role === "system")?.content;
        const systemText = typeof system === "string" ? system : "";

        if (systemText.startsWith("你是 LlamaDesk 的子智能体")) {
          subagentRequests += 1;
          // 第一次：给一个短 bash（0.5s，足够观察但不会超时太久）
          if (subagentRequests === 1) {
            return toolCallChunks(model, "bash", { command: "sleep 1" });
          }
          // 第二次：给文本结论
          return textChunks(model, "子智能体已完成。");
        }

        // 主 Agent
        const hasUserMsg = messages.some(
          (message) => message.role === "user" && JSON.stringify(message.content ?? "").includes("subagent-stop2"),
        );
        if (hasUserMsg) {
          return toolCallChunks(model, "task", {
            description: "测试停止回归",
            prompt: "跑一条 sleep 命令",
            subagent_type: "general",
          });
        }
        return textChunks(model, "主 Agent 收到结论。");
      },
    });

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

      const conversation = Chat.createConversation("子智能体停止回归", "agent");

      const turnPromise = Agent.runAgentTurn({
        conversationId: conversation.id,
        content: "subagent-stop2：派子智能体跑 sleep。",
        mode: "agent",
        workspace,
      });

      // 等待子智能体发出至少 1 次请求
      const madeRequest = await waitUntil(() => subagentRequests >= 1, 5000);
      expect(madeRequest).toBe(true);

      const reqsBeforeStop = subagentRequests;

      // 停止
      Agent.stopAgentRun(conversation.id);

      const turn = await turnPromise;

      // 停止后子智能体的请求数不应再增长
      // （04b 的 makeContextTransform 在下次模型调用前抛中止错）
      expect(subagentRequests).toBe(reqsBeforeStop);
    } finally {
      stub.stop();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
