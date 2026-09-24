import { afterAll, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";

import { installFetchRouter } from "./test-mocks";
// 只导类型（会被擦除）：模块本体仍走下面的动态 import，避免它带来的初始化顺序问题。
import type { VoiceCallOutgoing } from "./voice-call";

/**
 * 通话模式 omni 的回合收尾。
 *
 * 这里锁的是一个真实缺陷：omni 直接打 HTTP，没有 `streamChatTurn` 那一层，所以
 * 助手消息的**占位、流式回填、定稿落库**都得自己来。当时只接了"流式文本 → 逐句 TTS"，
 * 结果回答听得到、消息列表里却一直是空的 —— 而且声音一过就再也看不到刚才说了什么。
 *
 * 顺带钉住另一端：没配语音识别时，用户那一轮用占位文本落库，而不是少一条消息
 * （少一条会让整段通话读起来像助手在自言自语）。
 */
const CloudProviders = await import("./cloud-providers");
const { updateSettings } = await import("./db/settings");
const VoiceCall = await import("./voice-call");
const { db } = await import("./db");
const { messages } = await import("./db/schema");

const originalFetch = globalThis.fetch;
const setFetch = installFetchRouter();

const CHAT_TEXT = "你好，我在听。";
const SSE = [
  `data: ${JSON.stringify({ choices: [{ delta: { content: "你好，" } }] })}`,
  "",
  `data: ${JSON.stringify({ choices: [{ delta: { content: "我在听。" } }] })}`,
  "",
  "data: [DONE]",
  "",
].join("\n");

// 走内置预设建一行厂商：omni 的地址与密钥都从它取。
CloudProviders.createCloudProvider({ presetId: "qwencloud" });
CloudProviders.updateCloudProvider("qwencloud", { apiKey: "sk-intl-test" });
updateSettings({
  VOICE_CALL_OMNI_PROVIDER_ID: "qwencloud",
  VOICE_CALL_OMNI_MODEL: "qwen3.8-omni-flash",
  UI_LANG: "zh",
});

// 只放行对话请求，其余一律 400：TTS 合成会被 kickSpeak 吞掉（它按句 try/catch），
// 而这样也保证用例**一次外网都不打**（真实的 Edge TTS 会走同一个全局 fetch）。
setFetch(
  mock(async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/chat/completions")) {
      return new Response(SSE, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response("stub: 未支持的端点", { status: 400 });
  }) as never,
);

const events: VoiceCallOutgoing[] = [];
const unsubscribe = VoiceCall.onVoiceCallEvent((e) => events.push(e));

afterAll(() => {
  unsubscribe();
  globalThis.fetch = originalFetch;
  updateSettings({ VOICE_CALL_OMNI_PROVIDER_ID: "" });
});

/** 轮询等助手消息落库（回合是异步跑的，endVoiceCallUtterance 不等它）。 */
async function waitForAssistant(conversationId: number) {
  for (let i = 0; i < 100; i++) {
    const row = db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .all()
      .find((m) => m.role === "assistant" && m.content.trim());
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

test("omni 回合：回答既要念出来，也要落库并推给界面", async () => {
  const started = await VoiceCall.startVoiceCall({ provider: "omni" });
  expect(started.ok).toBe(true);
  const conversationId = started.conversation!.id;

  // 1280 字节以下算误触发，这里给足 0.5 秒的静音 PCM。
  VoiceCall.pushVoiceCallAudio({
    conversationId,
    wavBase64: Buffer.alloc(16000).toString("base64"),
    format: "pcm",
  });
  const ended = await VoiceCall.endVoiceCallUtterance({ conversationId });
  expect(ended.ok).toBe(true);

  const userRow = db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .all()
    .find((m) => m.role === "user");
  // 这个环境里没配语音识别：用户那一轮仍要留下一条消息，而不是凭空消失。
  expect(userRow?.content).toBe("（语音输入）");

  const assistant = await waitForAssistant(conversationId);
  expect(assistant).not.toBeNull();
  expect(assistant!.content).toBe(CHAT_TEXT);

  // 界面上这条气泡是靠这组事件画出来的：没有它们就只有声音、没有文字。
  const partials = events.filter((e) => e.type === "assistantPartial");
  const done = events.filter((e) => e.type === "assistantDone");
  expect(partials.length).toBeGreaterThan(0);
  expect(partials.every((e) => e.type === "assistantPartial" && e.messageId === assistant!.id)).toBe(true);
  // 增量拼起来就是定稿全文（气泡流式回填与落库内容一致）。
  expect(
    partials.map((e) => (e.type === "assistantPartial" ? e.text : "")).join(""),
  ).toBe(CHAT_TEXT);
  expect(done).toHaveLength(1);
  expect(done[0]).toMatchObject({ messageId: assistant!.id, text: CHAT_TEXT });

  VoiceCall.stopVoiceCall(conversationId);
});

test("没配厂商时拨号被拒，并指向真正要改的那一页", async () => {
  updateSettings({ VOICE_CALL_OMNI_PROVIDER_ID: "" });
  const res = await VoiceCall.startVoiceCall({ provider: "omni" });
  expect(res.ok).toBe(false);
  expect(res.error).toContain("omni 模式未选择云厂商");
  updateSettings({ VOICE_CALL_OMNI_PROVIDER_ID: "qwencloud" });
});
