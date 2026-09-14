/**
 * 实时语音通话（DashScope Qwen Realtime）的常量。
 *
 * 放在 shared 是因为**两个进程都要用**：主进程拿它们当默认配置，通话页要拿
 * `DEFAULT_REALTIME_MODEL` 去厂商模型清单里挑出对应的那张牌。webview 不能从
 * `bun/realtime-voice.ts` 值导入 —— 那个模块（经 cloud-providers → db → paths）
 * 会在模块级调用 `os.homedir()`，而 webview 里没有 Node 内置模块，一加载就整页白屏。
 * 前端包只允许值导入 shared 与第三方依赖，类型导入不受此限。
 */

/** 可选的云端实时模型（qwen-audio-agent 默认即 plus 档）。 */
export const REALTIME_MODELS = [
  "qwen-audio-3.0-realtime-plus",
  "qwen-audio-3.0-realtime-flash",
  "qwen3.5-omni-flash-realtime",
  "qwen3.5-omni-plus-realtime",
] as const;

export const DEFAULT_REALTIME_BASE_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
export const DEFAULT_REALTIME_MODEL = "qwen-audio-3.0-realtime-plus";
export const DEFAULT_REALTIME_VOICE = "longanqian";
