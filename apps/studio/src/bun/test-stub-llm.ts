/**
 * 脚本化桩推理服务（测试工具）：`Bun.serve` 起在随机端口，认 `/v1/models` 与
 * chat completions，把调用方给的 chunk 序列包成 SSE 流吐回去。
 *
 * 从 `scripts/agent-resilience-smoke.ts` 抽出来的**纯传输层管道**：
 * 不含任何具体任务的剧本 / 观测 / 断言 —— 「这一步该回什么」全部由调用方
 * 的 `respond` 回调决定，所以它也能给别的冒烟 / 测试复用。
 *
 * 不要在这里 import 任何被测对象（agent* 模块）—— 桩是桩，被测系统
 * 通过 HTTP 边界接入（`base` + 模型名即可）。
 */

/** chat completions 请求里桩关心的部分。 */
export type StubRequest = {
  model: string;
  messages: { role: string; content?: unknown; tool_calls?: unknown }[];
  tools?: { function?: { name?: string } }[];
};

/**
 * 一段 SSE chunk。`delta` 是 `choices[0].delta`（reasoning_content / content /
 * tool_calls 等），`finish` 是 `finish_reason`（不给 = 流中途被掐断）。
 */
export function sseChunk(
  model: string,
  delta: Record<string, unknown>,
  finish: string | null = null,
): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-stub",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

/**
 * 一次工具调用拆成的 chunk 序列：先给 id/name 的空参头，再把参数 JSON
 * 按 24 字符分片流出去，最后以 `finish_reason: "tool_calls"` 收尾。
 */
export function toolCallChunks(model: string, name: string, args: unknown): string[] {
  const json = JSON.stringify(args);
  const chunks = [
    sseChunk(model, {
      role: "assistant",
      content: "",
      tool_calls: [
        { index: 0, id: `call_${name}`, type: "function", function: { name, arguments: "" } },
      ],
    }),
  ];
  for (let i = 0; i < json.length; i += 24) {
    chunks.push(
      sseChunk(model, {
        tool_calls: [{ index: 0, function: { arguments: json.slice(i, i + 24) } }],
      }),
    );
  }
  chunks.push(sseChunk(model, {}, "tool_calls"));
  return chunks;
}

/** 纯文本回复拆成的 chunk 序列：8 字符一片，带 usage、以 `stop` 收尾。 */
export function textChunks(model: string, text: string): string[] {
  const chunks = [sseChunk(model, { role: "assistant", content: "" })];
  for (let i = 0; i < text.length; i += 8) {
    chunks.push(sseChunk(model, { content: text.slice(i, i + 8) }));
  }
  chunks.push(
    `data: ${JSON.stringify({
      id: "chatcmpl-stub",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 200, completion_tokens: 60, total_tokens: 260 },
    })}\n\n`,
  );
  return chunks;
}

export type StubLlm = {
  /** 形如 `http://127.0.0.1:<port>/v1`，可直接塞进引擎的 base url 设置。 */
  base: string;
  port: number;
  stop(): void;
};

export type StartStubLlmOptions = {
  /**
   * 每次收到 chat completions 请求时被调用，返回这一次要吐的 chunk 序列；
   * 也可以直接返回一个 `Response`（非 200 / 非 SSE，比如 503）表示
   * 「这次不按脚本走」，服务器原样透传。
   */
  respond: (request: StubRequest) => string[] | Response | Promise<string[] | Response>;
  /** `/v1/models` 里报的模型 id（默认 `stub-model`）。 */
  modelId?: string;
};

export function startStubLlm(opts: StartStubLlmOptions): StubLlm {
  const modelId = opts.modelId ?? "stub-model";
  const stub = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/models")) {
        return Response.json({
          object: "list",
          data: [{ id: modelId, object: "model", created: Date.now(), owned_by: "stub" }],
        });
      }
      const body = (await request.json()) as {
        model?: string;
        messages?: { role: string; content?: unknown; tool_calls?: unknown }[];
        tools?: { function?: { name?: string } }[];
      };
      const model = body.model ?? modelId;
      const response = await opts.respond({
        model,
        messages: body.messages ?? [],
        tools: body.tools,
      });
      if (response instanceof Response) return response;
      const chunks = response;
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(new TextEncoder().encode(chunk));
              await new Promise((resolve) => setTimeout(resolve, 3));
            }
            // 正常流以 [DONE] 收尾；被掐断的流不给。
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
    },
  });
  return {
    base: `http://127.0.0.1:${stub.port}/v1`,
    port: stub.port ?? 0,
    // 强制关闭（原冒烟脚本用的就是 stop(true)）：不带 true 会等在途请求排空，
    // 测试里一旦有没读完的流就会把整个进程挂在退出前。
    stop: () => stub.stop(true),
  };
}
