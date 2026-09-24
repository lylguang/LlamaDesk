/**
 * 通话模式的第三种接法：**omni 模式**（音频直送多模态对话模型）。
 *
 * 与另外两种的区别：
 *   - `local`：本地 ASR → 对话模型 → TTS，三段管线（用户的话先变成文字）；
 *   - `cloud`：全双工 WebSocket 实时语音（服务端 VAD + 服务端出声）；
 *   - `omni` ：本地 VAD 采集整段音频 → 直接作为**音频输入**发给 OpenAI 兼容的
 *     Chat Completions（`qwen3.8-omni-flash` 这类模型），流式收文字 → 逐句 TTS 播出。
 *
 * 为什么值得单独一档：省掉 ASR 这一段（少一次转写、少一次文本化损失），模型直接听
 * 原声。代价是它**不是全双工**——音频要说完才发，且这些模型只出文字（官方文档明确
 * "do not set audio"），所以播报仍走原来的 TTS。
 *
 * 放在 shared 是因为两个进程都要用（见本文件下面的常量），且 webview 不能值导入
 * `bun/omni-call.ts`（那个模块经 cloud-providers → db → paths 会碰到 Node 内置模块）。
 */

/** omni 模式的默认模型（qwencloud / 百炼国际站上的非实时 omni 对话模型）。 */
export const VOICE_CALL_OMNI_DEFAULT_MODEL = "qwen3.8-omni-flash";

/**
 * 页面上给用户挑的候选（厂商清单里带 omni 的模型也会并进来，这里只是兜底）。
 *
 * 只列**非实时**的 omni：`*-realtime` 那族要连 WebSocket，是"云端模式"的菜，
 * 混进来只会在第一次拨号时报一句看不懂的错。
 */
export const VOICE_CALL_OMNI_MODELS = [
  "qwen3.8-omni-flash",
  "qwen3.5-omni-plus",
  "qwen3.5-omni-flash",
  "qwen-omni-turbo",
] as const;

/**
 * 这个模型 id 像不像"能吃音频的对话模型"（omni 族）。
 *
 * 用来预填 omni 模式的模型下拉：厂商清单里 `qwen3.8-omni-flash` 会被分类成 `chat`
 * （它确实也是普通对话模型），不按 `omni` 认一下就得让用户手工敲 id。
 * 实时的 omni 由 `isRealtimeModelId` 负责挡掉，这里不重复判。
 */
export function isOmniAudioModelId(id: string): boolean {
  return /omni/i.test(id) && !/realtime/i.test(id);
}

/**
 * 音频输入的容器格式。采集端录的是 16k / 16bit / 单声道，所以整段音频可以直接
 * 包一个 WAV 头当容器送给模型（OpenAI 兼容面只认容器格式，不认裸 PCM）。
 */
export const OMNI_CALL_AUDIO_FORMAT = "wav" as const;

/**
 * 没能拿到用户转写时，落库的那句占位文本。
 *
 * omni 模式不需要 ASR，所以"用户到底说了什么"可能压根没有文字版本；但通话记录里
 * 少一条用户消息会让整段对话读起来像助手在自言自语，而且下一轮把它作为上下文回放时
 * 也会缺一环。所以没转写就写这句。
 *
 * **故意不进 i18n 的字典**：它是写进数据库的**数据**（和消息正文一样），不是界面
 * 文案 —— 挂进 i18n 的话，同一句历史消息会随用户切语言而"变成"另一种语言。语言在
 * **写入那一刻**定一次（取 UI_LANG），之后再读就固定是当时那句。
 */
export const OMNI_CALL_UNTYPED_USER_TEXT = {
  zh: "（语音输入）",
  en: "(voice input)",
} as const;

/** 按写入时的界面语言取占位文本（认不出的一律中文，与 i18n 的回退方向一致）。 */
export function omniUntypedUserText(lang: string | null | undefined): string {
  return lang === "en" ? OMNI_CALL_UNTYPED_USER_TEXT.en : OMNI_CALL_UNTYPED_USER_TEXT.zh;
}
