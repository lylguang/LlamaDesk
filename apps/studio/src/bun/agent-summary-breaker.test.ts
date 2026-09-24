/**
 * 摘要熔断：`makeContextTransform` 每次模型调用前都会跑，而摘要超时是 90 秒。
 *
 * 已发生的问题：摘要一直失败（模型不支持 / 返回格式不对 / 每次超时）时，一个十几步的
 * 回合里**每一步都重新试一次摘要，每次最多再等 90 秒** —— 凭空多花十几分钟，用户
 * 只看到「处理中」的秒数在涨。代码本来就设计了退路（失败退回确定性裁剪），
 * 问题是它没记住自己失败过。
 *
 * 本文件钉住三条语义：失败记下时刻、冷却期内不再尝试、成功后熔断清除。
 *
 * `makeContextTransform` 是导出的，这里直接构造 `CompactionHost` 调它：
 * 不必起完整回合。摘要调用走 `test-stub-llm` 的桩推理服务（remote 模式指向桩），
 * 桩对「摘要请求」（提示里带「待压缩的历史」）按用例剧本回 500 或正常文本。
 */
import { afterEach, describe, expect, test } from "bun:test";

import type { Model } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

import { makeContextTransform, type CompactionHost } from "./agent";
import { updateSettings } from "./db/settings";
import { startStubLlm, textChunks, type StubLlm } from "./test-stub-llm";

/** 500（可重试字样）：pi-ai 抛错 → `summarizeHistory` 归一成 `ok: false`。 */
function serverError(): Response {
  return new Response(
    JSON.stringify({ error: { message: "Internal server error", type: "server_error" } }),
    { status: 500, headers: { "content-type": "application/json" } },
  );
}

/** 摘要请求的指纹：`buildSummaryPrompt` 把待压缩的历史包在这段标记里。 */
const isSummaryRequest = (r: { messages: { role: string; content?: unknown }[] }): boolean =>
  JSON.stringify(r.messages).includes("待压缩的历史");

const SUMMARY_TEXT = "## 目标\n把项目跑起来\n## 已完成\n跑起来了\n## 关键结论与决策\n（无）\n## 涉及的文件\na.ts\n## 未解决 / 下一步\n（无）";

function startFailStub(): { stub: StubLlm; requests: () => number } {
  let count = 0;
  const stub = startStubLlm({
    respond: (r) => {
      count += 1;
      return isSummaryRequest(r) ? serverError() : textChunks(r.model, "ok");
    },
  });
  return { stub, requests: () => count };
}

function startOkStub(): { stub: StubLlm; requests: () => number } {
  let count = 0;
  const stub = startStubLlm({
    respond: (r) => {
      count += 1;
      return textChunks(r.model, isSummaryRequest(r) ? SUMMARY_TEXT : "ok");
    },
  });
  return { stub, requests: () => count };
}

function buildBundle(stubBase: string): { model: Model<"openai-completions">; models: ReturnType<typeof createModels> } {
  const model: Model<"openai-completions"> = {
    id: "stub-model",
    name: "stub-model",
    api: "openai-completions",
    provider: "omni-studio",
    baseUrl: stubBase,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };
  const models = createModels();
  models.setProvider(
    createProvider({
      id: "omni-studio",
      name: "OmniStudio",
      baseUrl: stubBase,
      auth: {
        apiKey: {
          name: "OmniStudio inference server",
          resolve: async () => ({ auth: { apiKey: "EMPTY" }, source: "env" as const }),
        },
      },
      models: [model],
      api: openAICompletionsApi() as never,
    }),
  );
  return { model, models };
}

/**
 * 顶穿云端默认窗口（256k）预算的历史：7 轮 × 12 万字符 ≈ 7 万 tokens。
 * `as never` 与流水线测试同型：`AgentMessage` 联合不接受普通对象字面量，
 * `makeContextTransform` 内部按 `{ role?, content? }` 形状消费它。
 */
const bigMessages = (): AgentMessage[] => {
  const big = (label: string) =>
    ({ role: "user", content: [{ type: "text", text: `${label} ${"x".repeat(120_000)}` }] } as never);
  return [
    { role: "user", content: [{ type: "text", text: "任务：修好它" }] } as never,
    big("历史 0"),
    big("历史 1"),
    big("历史 2"),
    big("历史 3"),
    big("历史 4"),
    big("最近 5"),
    big("最近 6"),
  ];
};

function newHost(): CompactionHost {
  return { workspace: "/tmp/omni-summary-breaker-ws", summary: null, compactedDropped: 0, summaryFailedAt: null };
}

afterEach(() => {
  updateSettings({ SERVER_MODE: "local", AGENT_COMPACT_MODE: "summary", MEMORY_ENABLED: "1" });
});

// 每次运行取一个不重复的会话 id：`agent.ts` 的停止请求表是模块级共享状态，而 bun test
// 在进程内并发跑测试文件，其它文件（agent-turn / agent-shutdown / agent-queue / …）会真实
// 登记停止请求；固定的 id 可能撞上，撞上就误抛「aborted」。每个用例取一个新 id，
// 把撞上的概率压到百万分之一以下，也避开同文件内用例之间的残留。
const conversationId = () => 100_000 + Math.floor(Math.random() * 1_000_000);

describe("摘要熔断", () => {
  test("摘要失败后会记下失败时刻", async () => {
    const { stub, requests } = startFailStub();
    try {
      updateSettings({
        SERVER_MODE: "remote",
        VLLM_API_BASE: stub.base,
        VLLM_API_KEY: "EMPTY",
        VLLM_MODEL_NAME: "stub-model",
        AGENT_COMPACT_MODE: "summary",
        MEMORY_ENABLED: "0",
      });
      const { model, models } = buildBundle(stub.base);
      const host = newHost();
      const transform = makeContextTransform(host, conversationId(), { model, models, streamFn: null } as never);

      const out = await transform(bigMessages());
      expect(requests()).toBe(1);
      // 摘要失败没有留下摘要（退路是确定性裁剪），且历史被压回窗口之内。
      expect(host.summary).toBeNull();
      expect(out.length).toBeLessThan(bigMessages().length);
      expect(host.summaryFailedAt).not.toBeNull();
    } finally {
      stub.stop();
    }
  });

  test("冷却期内不再尝试摘要：紧接着的下一步直接走确定性裁剪", async () => {
    const { stub, requests } = startFailStub();
    try {
      updateSettings({
        SERVER_MODE: "remote",
        VLLM_API_BASE: stub.base,
        VLLM_API_KEY: "EMPTY",
        VLLM_MODEL_NAME: "stub-model",
        AGENT_COMPACT_MODE: "summary",
        MEMORY_ENABLED: "0",
      });
      const { model, models } = buildBundle(stub.base);
      const host = newHost();
      const transform = makeContextTransform(host, conversationId(), { model, models, streamFn: null } as never);

      await transform(bigMessages());
      expect(host.summaryFailedAt).not.toBeNull();
      const afterFirst = requests();
      expect(afterFirst).toBeGreaterThan(0);

      // 同一回合的下一步：transform 又跑了一次。修之前这里会再发一次 90 秒的摘要调用；
      // 修之后冷却期内必须一条新的摘要请求都不发。
      const out = await transform(bigMessages());
      expect(requests()).toBe(afterFirst);
      // 这一轮照常发得出去（确定性裁剪兜底），历史仍然被压回窗口之内。
      expect(out.length).toBeLessThan(bigMessages().length);
    } finally {
      stub.stop();
    }
  });

  test("摘要成功会把熔断清掉", async () => {
    const { stub, requests } = startOkStub();
    try {
      updateSettings({
        SERVER_MODE: "remote",
        VLLM_API_BASE: stub.base,
        VLLM_API_KEY: "EMPTY",
        VLLM_MODEL_NAME: "stub-model",
        AGENT_COMPACT_MODE: "summary",
        MEMORY_ENABLED: "0",
      });
      const { model, models } = buildBundle(stub.base);
      // 上次失败是 6 分钟前（冷却期 5 分钟之外）：这一轮必须真的去试摘要。
      const host = newHost();
      host.summaryFailedAt = Date.now() - 6 * 60_000;
      const transform = makeContextTransform(host, conversationId(), { model, models, streamFn: null } as never);

      const out = await transform(bigMessages());
      expect(requests()).toBe(1);
      expect(host.summary).not.toBeNull();
      expect(host.summary!.text).toContain("把项目跑起来");
      expect(host.summaryFailedAt).toBeNull();
      // 摘要替换了被覆盖的旧历史。
      expect(out.length).toBeLessThan(bigMessages().length);
    } finally {
      stub.stop();
    }
  });
});
