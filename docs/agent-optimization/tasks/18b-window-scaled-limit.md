# 任务 18b：单条工具输出上限固定 24000 字符，不随上下文窗口缩放

工作树根目录：`/home/xixi/Git/OmniStudio/.claude/worktrees/agent-optimize`

## 允许改动的文件（只有这三个）

1. `apps/studio/src/bun/agent-spill.ts` —— 只许**新增**一个导出函数，不许改现有任何函数
2. `apps/studio/src/bun/agent-spill.test.ts` —— 只许加用例，现有 24 条一条都不许删、不许改
3. `apps/studio/src/bun/agent.ts` —— **只许改 `makeToolOutputHook` 这一个函数，外加改一行 import**。这个文件有 3300 多行，**不要通读它**，按下面给的行号直接定位。

别的文件一个都不许碰。

## 现状

`apps/studio/src/bun/agent-spill.ts` 第 24 行：

```
24  export const MAX_TOOL_OUTPUT_CHARS = 24_000;
```

`apps/studio/src/bun/agent.ts` 第 642 到 660 行，`makeToolOutputHook`（工具输出进模型之前的统一钩子）：

```
647      const text = resultText(context.result);
648      if (text.length <= MAX_TOOL_OUTPUT_CHARS) return undefined;
649      const spill = spillToolOutput({ conversationId, toolName: context.toolCall.name, text });
...
657      return {
658        content: [{ type: "text" as const, text: truncateForModel(text, { spillPath: spill?.path ?? null }).text }],
659      };
```

`truncateForModel` 没传 `maxChars`，所以内部也退回 `MAX_TOOL_OUTPUT_CHARS`。

## 缺陷

24000 是个写死的数，**跟上下文窗口没有任何关系**。

窗口大小由 `apps/studio/src/bun/agent-context.ts` 第 49 行 `contextWindowTokens()` 给出，本地模式下取的是引擎设置里的值，常见是 8192。

按项目自己的估算口径（`shared/token-estimate.ts`：中文约 1 字 1 token，其它约 4 字符 1 token），24000 个字符换算下来是 6000 到 24000 个 token。也就是说在 8k 窗口下，**单独一条工具结果就能吃掉大半个甚至整个窗口**。压缩和摘要都来不及救——那一轮直接顶满。

窗口大的时候（比如 128k）24000 字符完全不成问题，所以这不是「把常量调小」能解决的，得按窗口算。

## 期望语义

**在 `agent-spill.ts` 里新增一个纯函数**，按窗口算出单条工具结果允许占的字符数：

```
/**
 * 单条工具结果允许占的字符数：按窗口比例算，再夹到 [2000, MAX_TOOL_OUTPUT_CHARS]。
 *
 * 纯函数（窗口值由调用方取），便于单测。
 */
export function toolOutputCharLimit(windowTokens: number): number {
  ...
}
```

三个参数**必须写成这三个具名常量**（名字和值都照抄，放在新函数上面）：

```
/** 单条工具结果最多占窗口的比例，其余留给系统提示、历史与模型的回答。 */
const TOOL_OUTPUT_WINDOW_SHARE = 0.25;
/** token 换字符的折算比：中文约 1、英文约 4，工具输出偏英文但不能按 4 算得太乐观。 */
const TOKEN_TO_CHAR_RATIO = 3;
/** 再小的窗口也要让模型看到一点东西。 */
const MIN_TOOL_OUTPUT_CHARS = 2_000;
```

规则：

- 上限 = `windowTokens × TOOL_OUTPUT_WINDOW_SHARE × TOKEN_TO_CHAR_RATIO`，取整。
- 结果夹在 `[MIN_TOOL_OUTPUT_CHARS, MAX_TOOL_OUTPUT_CHARS]` 区间内。上限就是现在这个 24000，**窗口再大也不放宽**，保持今天的行为。
- `windowTokens` 传进来是 0、负数、NaN、Infinity 这类非法值时，**退回 `MAX_TOOL_OUTPUT_CHARS`**，不要算出个奇怪的数。

算出来应该是这样（自己核对一遍）：

| 窗口 | 25% | ×3 | 夹取后 |
|---|---|---|---|
| 4096 | 1024 | 3072 | 3072 |
| 8192 | 2048 | 6144 | 6144 |
| 32768 | 8192 | 24576 | 24000（撞上限） |
| 131072 | 32768 | 98304 | 24000 |
| 1024 | 256 | 768 | 2000（撞下限） |

## 接线（`agent.ts`）

1. 第 110 到 115 行那个 import 块里，把 `toolOutputCharLimit` 加进去。
2. 第 93 到 97 行那个 import 块（来自 `./agent-context`）里，把 `contextWindowTokens` 加进去。
3. `makeToolOutputHook` 里，在第 647 行之后算出本次的上限：

   ```
   const limit = toolOutputCharLimit(contextWindowTokens());
   ```

4. 第 648 行的判断改用 `limit`。
5. 第 658 行给 `truncateForModel` **传上 `maxChars: limit`**。

**第 4 步和第 5 步必须用同一个 `limit`，这是最容易写错的地方。** 只改其中一处的话：判断还用 24000、截断用 6144，那么长度在 6144 到 24000 之间的输出会**一个字都不截**直接进上下文（因为第 648 行提前 return 了）；反过来则是判断用 6144、截断用 24000，超限的输出被判定要截、实际又没截到位。两种都是比现在更糟的状态。

第 650 到 656 行那条日志不用改。

## 测试要求

往 `apps/studio/src/bun/agent-spill.test.ts` 加用例，只测 `toolOutputCharLimit` 这个纯函数（`makeToolOutputHook` 是 `agent.ts` 里的模块私有函数，**不要**为了测它去导出它）。

至少覆盖这 4 条：

1. **8192 窗口算出 6144**（**这条就是本次要修的缺陷，改之前这个函数还不存在**）。
2. **大窗口被上限夹住**：131072 → 24000。
3. **小窗口被下限夹住**：1024 → 2000。
4. **非法值退回默认**：0、负数、NaN、Infinity 四种都测，结果都是 24000。

## 验收标准（汇报第 5 节逐条填）

- [ ] 新增的是纯函数，不读设置、不碰文件系统
- [ ] 比例、折算、夹取三步都对，上表五行都能对上
- [ ] 非法值退回 `MAX_TOOL_OUTPUT_CHARS`
- [ ] `agent.ts` 里第 648 行的判断和第 658 行的截断**用的是同一个 limit**
- [ ] 没有改 `truncateForModel`、`capToolResultText`、转存逻辑、`MAX_TOOL_OUTPUT_CHARS` 的数值
- [ ] `agent.ts` 里除了 `makeToolOutputHook` 和两行 import，别处一个字没动
- [ ] 现有 24 条用例一条没删没改，全绿
- [ ] 源码改动（两个文件合计）不超过 35 行

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/18b-window-scaled-limit.json
```

输出原样贴进汇报第 4 节。
