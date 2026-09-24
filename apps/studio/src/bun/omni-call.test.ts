import { afterAll, expect, mock, test } from "bun:test";

import { installFetchRouter } from "./test-mocks";

/**
 * 通话模式的 omni 后端（音频直送多模态对话模型）。
 *
 * 这里钉的是**发出去的那条请求长什么样** —— 它没有本地可验证的行为，错了只会在
 * 上游报一句 400，而"400"里看不出是少写了 `modalities`、还是音频塞错了字段。
 * 三条最贵的：
 *   1. 音频必须走 OpenAI 兼容的 `input_audio`（`data:;base64,` + 单独的 `format`），
 *      而且 `modalities` 只能是 `["text"]`（这些模型不出音频，设了会被拒）；
 *   2. 上下文要在插入本轮用户消息**之前**取 —— 否则刚写进去的占位文本会和音频一起
 *      发过去，模型先读到一句没信息量的话；
 *   3. 地址来自厂商行（国际站是 `dashscope-intl`），不是写死的国内端点。
 */
const CloudProviders = await import("./cloud-providers");
const { updateSettings } = await import("./db/settings");
const { streamOmniCall, testOmniCallConnection } = await import("./omni-call");

const originalFetch = globalThis.fetch;
const setFetch = installFetchRouter();

const PROVIDER_ID = "qwencloud";
const INTl_BASE = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

// 走预设建行：顺带钉住国际站这一行还在内置目录里（没有它，用户就只能看着
// 国内百炼的地址发一把国际站的 Key，然后收到 401）。
CloudProviders.createCloudProvider({ presetId: PROVIDER_ID });
CloudProviders.updateCloudProvider(PROVIDER_ID, { apiKey: "sk-intl-test" });
updateSettings({ VOICE_CALL_OMNI_PROVIDER_ID: PROVIDER_ID, VOICE_CALL_OMNI_MODEL: "qwen3.8-omni-flash" });

type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
const captured: Captured[] = [];

/** 一段像模像样的 SSE：两片正文 + usage 收尾（顺序也要能对上）。 */
const SSE = [
  `data: ${JSON.stringify({ choices: [{ delta: { content: "你好，" } }] })}`,
  "",
  `data: ${JSON.stringify({ choices: [{ delta: { content: "我在听。" } }] })}`,
  "",
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } })}`,
  "",
  "data: [DONE]",
  "",
].join("\n");

setFetch(
  mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    captured.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(SSE, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as never,
);

afterAll(() => {
  globalThis.fetch = originalFetch;
  updateSettings({ VOICE_CALL_OMNI_PROVIDER_ID: "" });
});

const lastUserContent = (body: Record<string, unknown>) => {
  const messages = body.messages as { role: string; content: unknown }[];
  return messages[messages.length - 1]!.content as Record<string, unknown>[];
};

test("请求打到厂商行给的地址，音频走 OpenAI 兼容的 input_audio", async () => {
  captured.length = 0;
  const deltas: string[] = [];
  const res = await streamOmniCall({
    wavBase64: "UklGRg==",
    instructions: "你是一个语音助手",
    history: [
      { role: "user", content: "（语音输入）" },
      { role: "assistant", content: "我在。" },
    ],
    onDelta: (d) => deltas.push(d),
  });

  expect(res.ok).toBe(true);
  // 流式增量与全文都要对：切句朗读靠前者，落库靠后者。
  expect(deltas.join("")).toBe("你好，我在听。");
  expect(res.text).toBe("你好，我在听。");

  expect(captured).toHaveLength(1);
  const { url, headers, body } = captured[0]!;
  expect(url).toBe(`${INTl_BASE}/chat/completions`);
  expect(headers.Authorization).toBe("Bearer sk-intl-test");

  expect(body.model).toBe("qwen3.8-omni-flash");
  // 这些模型只出文字：设了 audio 会被上游直接拒。
  expect(body.modalities).toEqual(["text"]);
  expect(body.stream).toBe(true);

  const messages = body.messages as { role: string; content: unknown }[];
  expect(messages[0]!.role).toBe("system");
  // 历史在前、本轮音频在后，且本轮用户文本没有被重复成一条独立消息。
  expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);

  const parts = lastUserContent(body);
  const audio = parts.find((p) => p.type === "input_audio")!;
  expect(audio).toBeDefined();
  const input = audio.input_audio as { data: string; format: string };
  // data 是 data URI（不带 media type），容器格式另由 format 声明。
  expect(input.data).toBe("data:;base64,UklGRg==");
  expect(input.format).toBe("wav");
  // 不能只发音频：模型还需要知道拿这段音频干什么。
  expect(parts.some((p) => p.type === "text")).toBe(true);
});

test("没配厂商时报的是「去哪配」，不是一句上游错误", async () => {
  updateSettings({ VOICE_CALL_OMNI_PROVIDER_ID: "" });
  captured.length = 0;
  const res = await streamOmniCall({
    wavBase64: "UklGRg==",
    instructions: "x",
    history: [],
    onDelta: () => {},
  });
  expect(res.ok).toBe(false);
  expect(res.error).toContain("omni 模式未选择云厂商");
  // 没配就不该发出请求。
  expect(captured).toHaveLength(0);
  updateSettings({ VOICE_CALL_OMNI_PROVIDER_ID: PROVIDER_ID });
});

test("上游报错时把 error.message 抠出来给用户看", async () => {
  setFetch(
    mock(
      async () =>
        new Response(JSON.stringify({ error: { message: "model not found: qwen3.8-omni-flash" } }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
    ) as never,
  );
  const res = await streamOmniCall({
    wavBase64: "UklGRg==",
    instructions: "x",
    history: [],
    onDelta: () => {},
  });
  expect(res.ok).toBe(false);
  expect(res.error).toBe("model not found: qwen3.8-omni-flash");
  // 还原成成功替身，免得把后面的用例带偏。
  setFetch(
    mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({
        url: String(_input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response(SSE, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as never,
  );
});

test("测试连接发的是文字 ping：验证的是 key + 模型 id 能不能用", async () => {
  captured.length = 0;
  const res = await testOmniCallConnection();
  expect(res.ok).toBe(true);
  expect(captured).toHaveLength(1);
  expect(captured[0]!.url).toBe(`${INTl_BASE}/chat/completions`);
  expect(captured[0]!.body.model).toBe("qwen3.8-omni-flash");
  expect(captured[0]!.body.stream).toBe(false);
});

test("测试连接对没填 Key 的厂商给的是引导语，而不是 401", async () => {
  CloudProviders.updateCloudProvider(PROVIDER_ID, { apiKey: "" });
  const res = await testOmniCallConnection();
  expect(res.ok).toBe(false);
  expect(res.error).toContain("API Key");
  CloudProviders.updateCloudProvider(PROVIDER_ID, { apiKey: "sk-intl-test" });
});
