# 任务 18a：工具输出截断只留头部，而构建/测试的关键信息在尾部

工作树根目录：`/home/xixi/Git/OmniStudio/.claude/worktrees/agent-optimize`

## 允许改动的文件（只有这两个）

1. `apps/studio/src/bun/agent-spill.ts` —— 源码，只许改 `truncateForModel` 这一个函数，外加在它上面加一个常量
2. `apps/studio/src/bun/agent-spill.test.ts` —— 既有测试文件，**只许加用例**；现有 17 条原则上不许改，**但如果某条断言确实与新语义冲突，不要硬凑，在汇报第 6 节说清楚是哪一条、冲突在哪、你建议怎么改**，等我放行再动。

别的文件一个都不许碰。特别注意：**不要动 `capToolResultText`**（那是内存防呆，和这条无关），**不要动转存逻辑**，**不要改 `MAX_TOOL_OUTPUT_CHARS` 的数值**（让上限随窗口缩放是另一条任务）。

## 现状

`apps/studio/src/bun/agent-spill.ts` 第 177 到 198 行：

```
177  export function truncateForModel(
178    text: string,
179    opts: { maxChars?: number; spillPath?: string | null } = {},
180  ): { text: string; truncated: boolean } {
181    const max = opts.maxChars ?? MAX_TOOL_OUTPUT_CHARS;
182    if (text.length <= max) return { text, truncated: false };
183    const rest = text.length - max;
184    const lines = [
185      `${text.slice(0, max)}`,
186      "",
187      `…（输出被截断：这里只显示了前 ${max} 个字符，后面还有约 ${rest} 个字符没有显示，**不要**把上面当成完整内容。`,
188    ];
```

## 缺陷

第 185 行 `text.slice(0, max)` —— **只留头部，尾部整个丢掉**。

这对 bash 的输出恰恰是最差的选择。跑测试、跑构建、装依赖时，有用的信息几乎全在尾部：

- 测试框架：前面是一行行 `(pass)`，**最后几行才是失败清单和统计**；
- 编译器：前面是进度，**最后是错误汇总和退出码**；
- 包管理器：前面是下载进度条，**最后是冲突或报错**。

现在模型拿到的是几百行「通过、通过、通过……」然后被告知「后面还有 8 万字符没显示」。它既看不到有没有失败，也看不到失败在哪——只能再跑一次并自己想办法收窄输出。

## 期望语义

**保留头部和尾部两段，中间挖空。**

1. 在 `truncateForModel` 上面加一个常量：

   ```
   /** 截断时头部占的比例：开头有命令与上下文，结尾有错误与统计，两头都要。 */
   const TRUNCATE_HEAD_RATIO = 0.7;
   ```

2. 超限时按这个比例切：头部 `Math.floor(max * TRUNCATE_HEAD_RATIO)` 个字符，尾部拿满剩下的额度（`max - 头部长度`），**从原文末尾取**。

3. 两段中间插一句说明，讲清楚中间省了多少：形如「…（中间省略了约 N 个字符）…」，N 就是 `text.length - max`。

4. 末尾那几句提示（被截了、还差多少、去哪儿找原文、怎么缩小范围重试）**全部保留**，只把第 187 行里「这里只显示了前 ${max} 个字符」那半句改成能准确描述新行为的说法（比如「只显示了开头和结尾各一段」）。「后面还有约 ${rest} 个字符没有显示」这半句**保持原样不要动**——现有用例在断言这个数字。

5. `truncated` 的语义不变；没超限时原样返回，行为不变；`opts.maxChars` 和 `opts.spillPath` 的处理都不变。

6. 头尾两段加起来必须**正好是 `max` 个字符**，不能比原来多占窗口。

## 测试要求

往 `apps/studio/src/bun/agent-spill.test.ts` 的 `describe("truncateForModel", ...)` 里加用例。

构造可区分的文本：**开头一段独特标记、中间一大段填充、结尾一段独特标记**，比如开头 `"START-MARKER"`、结尾 `"END-MARKER"`、中间用 `"m".repeat(...)` 撑到超限。

至少覆盖这 4 条：

1. **结尾的标记出现在结果里**（**这条就是本次要修的缺陷，改之前必须是红的**）。
2. **开头的标记也还在**，而且结果是以它开头的（防止改过头把头部丢了）。
3. **中间的省略说明里带着正确的省略字符数**。
4. **头尾两段合计正好 `max` 个字符**：可以用一个小的 `maxChars` 把边界算清楚再断言，别用默认的 24000 去凑。

## 验收标准（汇报第 5 节逐条填）

- [ ] 尾部被保留
- [ ] 头部仍在最前，且结果以原文开头
- [ ] 头尾合计正好等于 `max`
- [ ] 中间省略说明里的字符数正确
- [ ] 末尾那几句提示一句没少
- [ ] 「后面还有约 N 个字符没有显示」这半句没动
- [ ] 没超限时行为不变
- [ ] 没有动 `capToolResultText` / 转存逻辑 / `MAX_TOOL_OUTPUT_CHARS` 的数值
- [ ] 把 `agent-spill.ts` 的改动还原后，第 1 条用例会变红（你自己先试一遍）
- [ ] 源码改动不超过 25 行
- [ ] 如果有既有用例与新语义冲突，**照实报出来，不要硬改**

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/18a-truncate-head-tail.json
```

输出原样贴进汇报第 4 节。
