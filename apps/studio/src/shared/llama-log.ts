/**
 * 从 llama-server 的**启动日志**里回读实际生效的参数（T4e：闭合「预测 → 实测」）。
 *
 * 纯字符串处理，无 IO：`src/shared` 同时被主进程与 webview 引用，这里绝不能碰
 * node / bun / electrobun。解析规则对版本与 verbosity 宽容 —— 认不出就返回 null，
 * 宁可没有实测值也不猜。
 */

export type FlashAttnState = "on" | "off" | null;

/**
 * flash attention 这次到底开没开（llama.cpp 不同版本、不同 verbosity 措辞不一）：
 *   1. `llama_context: flash_attn            = enabled`（高 verbosity 才有）→ on/off
 *   2. `resolve_fused_ops: Flash Attention not supported, set to disabled`
 *      或 `flash attention … disabled`（警告级，禁用时才打）→ off
 *   3. 都没有 → null（**不要猜**）
 * 两种措辞同时出现时以第 1 条为准（`flash_attn = x` 是引擎自己的最终结论）。
 */
export function parseFlashAttnState(log: string): FlashAttnState {
  const exact = log.match(/flash_attn\s*=\s*(enabled|disabled)\b/i);
  if (exact?.[1] !== undefined) return exact[1].toLowerCase() === "enabled" ? "on" : "off";
  if (
    /flash attention not supported/i.test(log) ||
    /flash attention.*disabled/i.test(log)
  ) {
    return "off";
  }
  return null;
}

/**
 * `144.00 MiB` / `1.5 GiB` / `300 MB` 这类「数字 + 单位」→ 字节数（拿不到返回 null）。
 * 小数与整数都收；单位只认 MiB / MB / GiB（其余单位出现即跳过那条，宁缺勿错）。
 */
function parseSizeToBytes(text: string): number | null {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(MiB|MB|GiB)\b/i);
  if (m === null || m[1] === undefined || m[2] === undefined) return null;
  const value = Number.parseFloat(m[1]);
  if (!Number.isFinite(value) || value < 0) return null;
  const unit = m[2].toUpperCase();
  // 单位统一转大写再比（"GiB" → "GIB"），别拿大写去比小写形式
  const factor = unit === "GIB" ? 1024 ** 3 : 1024 ** 2;
  return Math.round(value * factor);
}

/**
 * `llama_kv_cache: size = 144.00 MiB (...)` —— 启动日志里可能出现多次
 * （全局 cache 与 SWA cache 各一条），把**所有**条目相加。一条都认不出 → null。
 */
export function parseKvCacheBytes(log: string): number | null {
  const total = sumSizes(
    log.match(/llama_kv_cache:\s*size\s*=\s*([^\n(]+)(?:\(|$)/gi) ?? [],
  );
  return total > 0 ? total : null;
}

/**
 * `xxx compute buffer size = 174.00 MiB` —— 同理可能多条（CPU / GPU 各一块），
 * 全部相加；一条都认不出 → null。
 */
export function parseComputeBufferBytes(log: string): number | null {
  const total = sumSizes(
    log.match(/compute buffer size\s*=\s*([^\n(]+)(?:\(|$)/gi) ?? [],
  );
  return total > 0 ? total : null;
}

function sumSizes(matches: string[]): number {
  let total = 0;
  for (const m of matches) {
    // `String.match` 带 g 标志时返回的是**整行字符串数组**（带捕获组的也只给整行，
    // 不像 `re.exec` 那样返回 MatchArray）——直接当字符串用，别取 [0]（那是第一个字符）。
    const bytes = parseSizeToBytes(m);
    if (bytes !== null) total += bytes;
  }
  return total;
}
