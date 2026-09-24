/**
 * 云模型的上下文窗口（token 数）：目录 + 解析规则（bun 与 mainview 共用）。
 *
 * 为什么要单独一个模块：窗口这个数被三处读，且**必须一致** ——
 * Agent 的自动压缩预算（`bun/agent.ts` 的 60%）、上下文占用展示
 * （`bun/agent-context.ts`）、以及设置页里给用户看的默认值。以前它只活在
 * `bun/chat-context.ts` 里，界面拿不到，于是"用户看到的窗口"和"压缩按的窗口"
 * 是两套数；更要命的是云端只有一句兜底 128K，模型真实窗口是 1M 的也被按 128K
 * 压缩 —— 会话很快被裁掉中间历史，用户体感就是"上下文太短、没法用"。
 *
 * 解析优先级（后者逐级兜底）：
 *   1. 用户为该模型手填的 `contextLength`（设置 → 云端模型 → 上下文列，落库）；
 *   2. 模型 id 自带的尺寸后缀（`moonshot-v1-8k` / `ernie-4.5-turbo-128k` / `-1m`）
 *      —— 后缀是模型名的一部分，比下面的名字目录更可信，所以排在它前面；
 *   3. 下面的**已知模型目录**（按厂商命名规则匹配，用于没有后缀的那些）；
 *   4. `DEFAULT_MODEL_CONTEXT`（256K）。
 *
 * 目录只收「有把握」的型号，宁可漏也不要猜错：**猜大**会让压缩迟迟不触发，
 * 请求最后撞上厂商的 `context_length_exceeded` 硬失败；**猜小**只是压缩得早一点。
 * 所以拿不准的型号一律走 256K 兜底（偏大但可控），用户在界面上能随时改。
 */

/** 认不出型号时的默认窗口：256K。 */
export const DEFAULT_MODEL_CONTEXT = 262_144;

/**
 * 本地模式的默认窗口（`SERVER_CTX_SIZE` 缺省值）。
 *
 * 这是 llama.cpp 的 KV 总量旋钮，缺省 8192 —— 与 `db/settings.ts` 里那个设置默认值、
 * 以及 `bun/chat.ts` 的旧内联兜底是同一个数。三处各写一份的话，"默认窗口"会随
 * 改动的先后漂移，所以这里是唯一真源（各引擎启动参数另有一套，见 shared/model-profiles.ts）。
 */
export const LOCAL_CTX_DEFAULT = 8192;

/**
 * 云端模型的单次输出上限（`max_tokens`）。
 *
 * 与上下文窗口是两件事，别混：厂商的输出天花板普遍远低于窗口（deepseek-chat 128K
 * 窗口但只让输出 8k、qwen-max 8k…），按窗口给会被厂商 400 拒掉，所以统一封 8k ——
 * 模型正常会自己 EOS 收尾，封得保守只是上限。Agent 与对话页用同一个值（以前各写各的，
 * 对话页还是从 `SERVER_CTX_SIZE` 推出来的：本地把 KV 调到 128k 后切云端，就会发出
 * `max_tokens: 131072`，稳定撞厂商输出上限）。
 */
export const CLOUD_MAX_OUTPUT_TOKENS = 8192;

/**
 * 窗口合法区间。下限 1024 与旧解析器一致；上限 16M 防御手滑 / 恶意 id
 * （qwen-long 的 10M 是已知最大的，留一倍余量）。
 */
export const MIN_MODEL_CONTEXT = 1024;
export const MAX_MODEL_CONTEXT = 16_777_216;

/**
 * 从模型 id 里解析它自带的窗口尺寸后缀：`-8k` / `-32k` / `-128k` / `-1m`。
 * 只认独立段（`-8k-`、`-8k_` 或结尾），避免把 `glm-4-flash-250414` 里的
 * 数字误当尺寸。解析不出来返回 undefined，交给名字目录 / 兜底。
 */
export function contextWindowFromModelId(id: string): number | undefined {
  const match = /-(\d{1,4})(k|m)(?:[-_.]|$)/i.exec(id);
  if (!match) return undefined;
  const size = Number(match[1]);
  const unit = match[2];
  if (!unit || !Number.isFinite(size) || size <= 0) return undefined;
  const scale = unit.toLowerCase() === "m" ? 1_048_576 : 1024;
  const tokens = size * scale;
  return clampContext(tokens);
}

/** 把窗口夹进合法区间；非有限 / 非正数返回 undefined（调用方继续兜底）。 */
export function clampContext(tokens: number): number | undefined {
  if (!Number.isFinite(tokens) || tokens <= 0) return undefined;
  if (tokens < MIN_MODEL_CONTEXT || tokens > MAX_MODEL_CONTEXT) return undefined;
  return Math.round(tokens);
}

/**
 * 已知云模型的窗口目录。按顺序匹配（更具体的规则写在前面），命中即返回。
 *
 * 值取各厂商文档里的公开窗口；写成了 1024 的整数倍（如 200K → 204800）以便
 * 界面按 `128K` / `1M` 这样干净地显示，相对真实文档值（200000）的偏差 <3%，
 * 对"压缩预算"这种用途没有影响。
 */
const MODEL_CONTEXT_CATALOG: readonly { test: RegExp; context: number; note: string }[] = [
  // ── 1M 档 ──────────────────────────────────────────────────────────────
  { test: /gemini/i, context: 1_048_576, note: "Gemini 1.5 / 2.x / 3 全系 1M" },
  { test: /gpt-4\.1/i, context: 1_048_576, note: "GPT-4.1 系 1M" },
  { test: /minimax-m1|minimax-text-01/i, context: 1_048_576, note: "MiniMax M1 / Text-01 1M" },
  // 百炼的长窗口档：turbo / flash / long 都是 1M（long 文档写 10M，按 1M 保守取）
  { test: /qwen-turbo|qwen-flash|qwen-long/i, context: 1_048_576, note: "千问 turbo/flash/long 1M 档" },

  // ── 256K 档 ────────────────────────────────────────────────────────────
  { test: /kimi-k2/i, context: 262_144, note: "Kimi K2 256K" },
  { test: /doubao-seed/i, context: 262_144, note: "豆包 Seed 系 256K" },

  // ── 200K 档 ────────────────────────────────────────────────────────────
  { test: /claude/i, context: 204_800, note: "Claude 4 系 200K（1M 需申请 beta）" },
  { test: /glm-4\.6/i, context: 204_800, note: "GLM-4.6 200K" },
  { test: /gpt-5/i, context: 409_600, note: "GPT-5 系 400K" },

  // ── 128K 档 ────────────────────────────────────────────────────────────
  // DeepSeek 官方 deepseek-chat / reasoner（V3.2）都是 128K —— **不是** 1M。
  // 按 1M 声明会让压缩线抬到 600K，请求在 128K 处稳定被厂商 400 拒掉。
  { test: /deepseek/i, context: 131_072, note: "DeepSeek V3.x 128K" },
  { test: /kimi-latest|moonshot/i, context: 131_072, note: "Kimi / Moonshot 非后缀型号 128K" },
  { test: /glm-4\.5|glm-4-plus|glm-4-air|glm-4-flash|glm-4(?![.\d])/i, context: 131_072, note: "GLM-4 系 128K" },
  { test: /gpt-4o|gpt-4-turbo/i, context: 131_072, note: "GPT-4o / 4-turbo 128K" },

  // ── 32K 档 ─────────────────────────────────────────────────────────────
  { test: /qwen-max/i, context: 32_768, note: "千问 max 32K（老档）" },
];

/** 名字目录查表；认不出返回 undefined。 */
export function catalogContextWindow(id: string): number | undefined {
  for (const rule of MODEL_CONTEXT_CATALOG) {
    if (rule.test.test(id)) return rule.context;
  }
  return undefined;
}

/**
 * 云模型的最终窗口：用户覆盖 → id 后缀 → 名字目录 → 256K 兜底。
 * `override` 来自用户在设置页手填的 `contextLength`（非法值当作没填）。
 */
export function resolveCloudContextWindow(id: string, override?: number | null): number {
  const explicit = override == null ? undefined : clampContext(override);
  if (explicit) return explicit;
  const trimmed = (id ?? "").trim();
  if (!trimmed) return DEFAULT_MODEL_CONTEXT;
  // 后缀（模型名自带）比名字目录（按厂商命名规则猜）更可信，所以排在前面。
  return (
    contextWindowFromModelId(trimmed) ?? catalogContextWindow(trimmed) ?? DEFAULT_MODEL_CONTEXT
  );
}

/**
 * 界面展示用：`1048576` → `1M`，`262144` → `256K`，非 1024 整数倍的照原样显示。
 */
export function formatContextWindow(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "";
  if (tokens % 1_048_576 === 0) return `${tokens / 1_048_576}M`;
  if (tokens % 1024 === 0) return `${tokens / 1024}K`;
  return String(tokens);
}

/**
 * 解析用户在输入框里填的窗口：`256k` / `1M` / `131072` 都认，也认纯数字后缀
 * （`256000` 这种非 1024 倍数的照收）。空串 / 认不出的返回 undefined
 * （= 清空覆盖，回到自动判断）。
 */
export function parseContextWindowInput(raw: string): number | undefined {
  const text = raw.trim().toLowerCase().replace(/[\s,]/g, "");
  if (!text) return undefined;
  const match = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(text);
  if (!match) return undefined;
  const size = Number(match[1]);
  if (!Number.isFinite(size) || size <= 0) return undefined;
  const unit = match[2];
  const tokens = unit === "m" ? size * 1_048_576 : unit === "k" ? size * 1024 : size;
  return clampContext(tokens);
}
