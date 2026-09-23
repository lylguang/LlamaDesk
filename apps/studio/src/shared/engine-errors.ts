/**
 * 引擎启动失败的分类型。
 *
 * 启动失败原来只有一行原文（`extractStartupError` 从日志尾巴里挑出来的那条），
 * 用户看到的是 `CUDA out of memory` 或 `Address already in use` —— 前者要调小
 * 上下文 / 换量化，后者要去关掉占端口的进程，两件事完全不相干却长得一样「都是失败」。
 * 分成类型之后界面才能给出「下一步做什么」，而不是让用户自己去搜错误原文。
 *
 * 分类只看**错误文本**，不看日志：调用点拿到的就是那一条已经挑好的行，
 * 因此这里是纯函数，两端（主进程写库 / webview 渲染提示）都能直接用。
 *
 * 顺序即优先级 —— 一条错误可能同时命中多个特征（例如 vLLM 缺依赖时也会打印
 * `No module named 'vllm'` 后面跟着一段 `CUDA error: out of memory` 的栈），
 * 先命中先归，把最能指导行动的那一类排在前面。
 */
export type StartupErrorKind =
  | "missing-dependency"
  | "vram-insufficient"
  | "disk-full"
  | "port-in-use"
  | "model-missing"
  | "model-format"
  | "permission"
  | "download-incomplete"
  | "unknown";

/** 全部类型（界面遍历渲染提示、测试用例表都用它）。 */
export const STARTUP_ERROR_KINDS: StartupErrorKind[] = [
  "missing-dependency",
  "vram-insufficient",
  "disk-full",
  "port-in-use",
  "model-missing",
  "model-format",
  "permission",
  "download-incomplete",
  "unknown",
];

/**
 * 认不出来的那类，以及**只能由上下文判定**的那类。
 *
 * `download-incomplete` 不在下面那张文本规则表里：错误原文（llama.cpp 只会说
 * "exiting due to model loading error"）看不出「文件还没下完」，只有应用自己知道
 * 下载队列里还挂着这个文件。所以它由调用方按上下文判定（见 `model-servers.ts`），
 * 这一层只负责给它一个类型和一句建议。
 */
export const TEXT_DERIVABLE_KINDS: StartupErrorKind[] = STARTUP_ERROR_KINDS.filter(
  (kind) => kind !== "download-incomplete" && kind !== "unknown",
);

const RULES: { kind: StartupErrorKind; pattern: RegExp }[] = [
  {
    // 缺依赖必须排在显存之前：venv 没装好时 torch 的导入失败信息里常常夹着
    // 一段 "CUDA out of memory"，把用户引向调参数就永远修不好。
    kind: "missing-dependency",
    pattern:
      /no module named|modulenotfounderror|importerror|cannot import name|cannot open shared object file|dll load failed|command not found|not recognized as an internal or external command|is not installed|please install|pip install|请安装|未安装/i,
  },
  {
    kind: "vram-insufficient",
    pattern:
      /out of memory|outofmemoryerror|cuda error|insufficient memory|not enough memory|failed to allocate|unable to allocate|can't allocate|cannot allocate|hip error|cuda malloc|cudamalloc|显存不足|内存不足/i,
  },
  {
    kind: "disk-full",
    pattern: /no space left on device|enospc|disk full|quota exceeded|磁盘空间不足|空间不足/i,
  },
  {
    kind: "port-in-use",
    pattern:
      /address already in use|eaddrinuse|already in use|failed to bind|error while attempting to bind|bind\(\) failed|端口.*占用|地址已被占用/i,
  },
  {
    kind: "permission",
    pattern:
      /permission denied|operation not permitted|eacces|eperm|access denied|cannot be opened because the developer cannot be verified|is damaged and can't be opened|quarantine|权限不足|拒绝访问/i,
  },
  {
    // 权重文件的问题：一是路径就没有这个文件，二是下到一半（GGUF 的 magic 不对）。
    // 两者对用户是同一件事的两个阶段，提示都是「先确认权重已下完，必要时重新下载」，
    // 所以合成一类，只是把原文留下来。
    kind: "model-missing",
    pattern:
      /no such file or directory|file not found|does not exist|cannot find the file|bad magic|invalid magic|magic number|not a valid (?:gguf|model)|unexpected end of file|tensor data is incomplete|incomplete file|找不到.*模型|模型文件不存在/i,
  },
  {
    kind: "model-format",
    pattern:
      /unknown model architecture|architecture .* not supported|model type .* not supported|unsupported model|unsupported gguf|unknown quantization|unknown tensor|failed to load model|invalid model|model type .* is not supported|架构.*不支持/i,
  },
];

/**
 * 把一条启动错误归到某一类；认不出就归 `unknown`（界面按 `unknown` 只显示原文，
 * 不硬编一句可能误导的「建议」）。
 */
export function classifyStartupError(errorText: string | undefined | null): StartupErrorKind {
  const text = (errorText ?? "").trim();
  if (!text) return "unknown";
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return rule.kind;
  }
  return "unknown";
}

/**
 * 该类型是不是「换个模型 / 换个参数就能好」——模型回退路由（PERF-03）用它决定
 * 要不要继续试备选模型。
 *
 * 端口被占、缺依赖、权限不足都跟模型无关：换了备选模型照样失败，
 * 这时候退回备选只会把真正的失败原因掩盖掉（用户看到的是「备选模型也起不来」），
 * 所以只有模型自身的问题才值得回退。
 */
export function isModelSideFailure(kind: StartupErrorKind): boolean {
  return (
    kind === "model-format" ||
    kind === "model-missing" ||
    kind === "vram-insufficient" ||
    // 配的这个模型还在下 —— 换一个已经下完的备选正好让应用能先用起来。
    kind === "download-incomplete"
  );
}
