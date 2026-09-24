# 任务 25a：把桩推理服务从冒烟脚本里抽成可复用的测试工具

工作树根目录：`/home/xixi/Git/OmniStudio/.claude/worktrees/agent-optimize`

## 允许改动的文件（只有这两个）

1. `apps/studio/src/bun/test-stub-llm.ts` —— 你要新建的模块
2. `apps/studio/scripts/agent-resilience-smoke.ts` —— 改成从新模块导入，**场景脚本本身不许改**

别的文件一个都不许碰。这次**不写新测试**，验收靠「冒烟脚本行为完全不变」。

## 为什么做这件事

`apps/studio/scripts/agent-resilience-smoke.ts` 里有一套完整的、脚本化的桩推理服务：`Bun.serve` 起在随机端口，认 `/v1/models` 和 chat completions，能按脚本吐流式正文、工具调用、半截流、空回合。它不依赖任何真实服务，1.4 秒跑完。

但它**锁死在这一个脚本里**。于是另外几条真缺陷验不动——它们都要「真跑完一个回合」才看得见：

- 排队消息被写库两次（`agent.ts:3142` 与 `:2465` 各插一次）
- 会话重入闸门（`agent.ts:2444`、`:2489` 的异步窗口里能并发起第二轮）
- 失败回合仍返回 `ok: true`（`agent.ts:3033`）

这三条的改法都清楚，卡的全是「没法在单测里跑一个回合」。把桩抽出来，它们就变成普通任务。

## 抽哪些、不抽哪些

**抽出去**（通用的传输层管道）：

- `sseChunk`（第 40 行附近）
- `textChunks`、`toolCallChunks`（第 54 行附近）
- 服务器骨架：`Bun.serve({ port: 0, ... })`，含 `/models` 分支、解析请求体、把 chunks 包成 SSE 流的那个 `stream` 辅助函数（第 259 行附近）

**留在冒烟脚本里**（场景特有的）：

- `seen` 那个观察记录对象
- `protocolViolation`、`toWireShape` 这些校验器
- 第 280 行往后所有「第几步该回什么」的脚本化应答
- 全部 `check(...)` 断言

## 新模块的形状

`apps/studio/src/bun/test-stub-llm.ts` 至少导出：

```
/** 一段 SSE chunk。 */
export function sseChunk(model: string, delta: Record<string, unknown>, finish?: string | null): string;

/** 纯文本回复拆成的 chunk 序列。 */
export function textChunks(model: string, text: string): string[];

/** 一次工具调用拆成的 chunk 序列。 */
export function toolCallChunks(model: string, name: string, args: unknown): string[];

export type StubRequest = {
  model: string;
  messages: { role: string; content?: unknown; tool_calls?: unknown }[];
  tools?: { function?: { name?: string } }[];
};

/**
 * 起一个脚本化的桩推理服务。
 * `respond` 每次收到 chat completions 请求时被调用，返回这一次要吐的 chunk 序列；
 * 返回 null 表示「这次不按脚本走」，由调用方自己处理（保留现有逻辑用得上的口子）。
 */
export function startStubLlm(opts: {
  respond: (request: StubRequest) => string[] | Response | Promise<string[] | Response>;
  modelId?: string;
}): { base: string; port: number; stop(): void };
```

`base` 返回 `http://127.0.0.1:<port>/v1`，和现在第 400 行拼的那个一致。

签名细节你可以按实际需要调整，但必须满足：**冒烟脚本改完之后，行为与现在逐字节一致**。

## 改冒烟脚本

只做「搬家」：删掉被抽走的那几个函数与 `Bun.serve` 调用，改成 `import { ... } from "../src/bun/test-stub-llm"` 再调 `startStubLlm({ respond })`，把原来 `fetch` 里第 280 行往后那段脚本化逻辑原样搬进 `respond`。

**场景本身一个字都不许改**：断言不许增删改，应答顺序不许变，`updateSettings` 的内容不许动，`AGENT_MAX_STEPS` 不许动。

## 自检（这条的验收全靠它）

在 `apps/studio` 目录下跑：

```
bun run scripts/agent-resilience-smoke.ts
```

要求：**退出码 0，29 个 ✓，0 个 ✗**。把输出最后 20 行贴进汇报第 2 节。

再在工作树根目录跑 `bun run test`，全量必须仍然全绿。

## 验收标准（汇报第 5 节逐条填）

- [ ] 新模块只含通用管道，不含任何这条任务场景特有的东西
- [ ] 冒烟脚本里场景部分一个字没改（断言、应答顺序、设置项）
- [ ] 冒烟退出码 0、29 个 ✓、0 个 ✗
- [ ] 全量单测仍然全绿
- [ ] 新模块没有 import 任何 `agent*` 模块（它是纯传输层工具，不该依赖被测对象）
- [ ] 没有动别的文件

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/25a-extract-stub-llm.json
```

输出原样贴进汇报第 4 节。

## 汇报第 6 节

写清你抽出去了哪几个函数、留下了哪些、有没有遇到「这段说不清算通用还是特有」的地方。
