/**
 * llama.cpp 的模型加载模式（`--load-mode`）：权重走不走 mmap、要不要锁在内存里。
 *
 * 这是 PERF-02 的落地形态 —— 「预填充内存防护」真正能拨的旋钮就是这一个：权重在
 * 物理内存里的驻留方式决定了系统内存紧张时是「换出去一点」还是「整机卡住/OOM」。
 * KV 缓存那一层由 `--cache-type-k/v` 管（已经在启动参数里），两者合起来才是分层防护。
 *
 * 为什么需要一张映射表：`--mlock` / `--no-mmap` **已被上游标记 DEPRECATED**，取而代之的
 * 是 `--load-mode MODE`（llama-server 0.4.0 / build 10809 的 --help 原文：
 * 「--mlock：DEPRECATED in favor of `--load-mode`」，取值 `auto|none|mmap|mlock|mmap+mlock|dio`）。
 * 但应用既可能用自己装的最新版，也可能用 `brew install llama.cpp` 那份旧版，所以按
 * `--help` 探测结果二选一，而不是赌某个版本。
 *
 * 旧版等价关系直接来自两版 --help 的措辞（不是猜的）：
 *  - 旧版默认就是 mmap，所以 `mmap` 在旧版**不发参数**；
 *  - 旧版 `--mlock` 的说明是「force system to keep model in RAM rather than swapping
 *    or compressing」，与新版 `mmap+mlock` 一字不差 ⇒ 两者等价；
 *  - 旧版 `--no-mmap` 是「不 mmap，加载慢些但不占页缓存」⇒ 新版没有 mmap 的加载方式；
 *  - `dio`（DirectIO）旧版没有对应开关 ⇒ 如实告知不支持，不静默降级成别的模式。
 */

export const LOAD_MODE_VALUES = ["auto", "mmap", "mlock", "mmap+mlock", "none", "dio"] as const;

export type LoadMode = (typeof LOAD_MODE_VALUES)[number];

export const DEFAULT_LOAD_MODE: LoadMode = "auto";

export function isLoadMode(value: string): value is LoadMode {
  return (LOAD_MODE_VALUES as readonly string[]).includes(value);
}

/** `--help` 支持的形态：新版认 `--load-mode`，旧版只有两个废弃开关，探测失败就是 unknown。 */
export type LoadModeSupport = "load-mode" | "legacy" | "unknown";

/** `llama-server --help` 的输出 → 支持形态。 */
export function parseLoadModeSupport(help: string): LoadModeSupport {
  if (/--load-mode\b/.test(help) || /(^|\s)-lm\b/.test(help)) return "load-mode";
  if (/--mlock\b/.test(help) || /--no-mmap\b/.test(help)) return "legacy";
  return "unknown";
}

/**
 * 设置值 + 支持形态 → 要追加的启动参数。
 *
 * `auto` / 空值一律不发参数：`auto` 就是 llama.cpp 自己的默认（能用 mmap 就用），
 * 显式传 `--load-mode auto` 与不传等价，少一段参数就少一处版本依赖。
 * `unknown`（没探测到）也返回空：宁可按默认启动，也不赌一个可能不存在的开关。
 */
export function loadModeArgs(mode: string | null | undefined, support: LoadModeSupport): string[] {
  if (!mode || mode === DEFAULT_LOAD_MODE) return [];
  if (!isLoadMode(mode)) return [];
  if (support === "load-mode") return ["--load-mode", mode];
  if (support === "unknown") return [];
  // 旧版：只有 --mlock / --no-mmap 两个开关，按等价关系折算。
  switch (mode) {
    case "mlock":
    case "mmap+mlock":
      return ["--mlock"];
    case "none":
      return ["--no-mmap"];
    case "mmap":
      return []; // 旧版默认就是 mmap
    default:
      return []; // dio：旧版没有
  }
}

/**
 * 这个模式在这台引擎上是不是「设了但发不出去」—— 调用方据此记一条日志/界面提示，
 * 而不是让用户以为设置生效了（静默无视是最难查的一类问题）。
 */
export function loadModeUnsupported(mode: string | null | undefined, support: LoadModeSupport): boolean {
  if (!mode || mode === DEFAULT_LOAD_MODE || !isLoadMode(mode)) return false;
  if (support === "load-mode") return false;
  if (support === "unknown") return true;
  // 旧版只有 --mlock / --no-mmap：除 dio 外都能折算过去（见 loadModeArgs 的表）。
  return mode === "dio";
}
