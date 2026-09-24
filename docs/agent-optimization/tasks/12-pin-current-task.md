# 任务 12：裁剪只钉住第一条消息，长回合里当前这一轮的任务陈述会被裁掉

工作树根目录：`/home/xixi/Git/OmniStudio/.claude/worktrees/agent-optimize`

## 允许改动的文件（只有这两个）

1. `apps/studio/src/bun/agent-compaction.ts` —— 源码，只许改 `compactMessages` 这一个函数
2. `apps/studio/src/bun/agent-compaction.test.ts` —— 既有测试文件，**只许加用例，现有 14 条一条都不许删、不许改**

别的文件一个都不许碰。特别注意：**不要动 `pruneSupersededReads`**，那是另一件事。

## 现状

`apps/studio/src/bun/agent-compaction.ts` 第 46 到 95 行，`compactMessages`。核心是第 56 到 67 行：

```
56    const head = messages[0]!;
57    const headTokens = estimateMessagesTokens([head]);
58    let used = headTokens;
59    const kept: T[] = [];
60    for (let index = messages.length - 1; index >= 1; index -= 1) {
61      const message = messages[index]!;
62      const cost = estimateMessagesTokens([message]);
63      // 至少保留最后 4 条（否则模型看不到刚刚发生了什么）。
64      if (kept.length >= 4 && used + cost > budgetTokens) break;
65      kept.unshift(message);
66      used += cost;
67    }
```

再往下第 73 行和第 79 行：

```
73    while (kept.length > 1 && isToolResult(kept[0])) kept.shift();
...
79    const compacted = [head, placeholder(dropped), ...kept];
```

函数头上的注释（第 40 行）写的是：

```
40   * - 第一条消息一定是任务陈述，永远保留（丢了模型就不知道要干什么）；
```

## 缺陷

「第一条消息就是任务陈述」这个前提，**只在单轮会话里成立**。

调用点在 `apps/studio/src/bun/agent.ts` 第 2042 到 2048 行，传进来的是**整个会话的历史**（有摘要时是摘要 + 摘要之后的全部）。所以到了第 5 轮对话，`messages[0]` 是**第 1 轮**的问题，而这一轮用户问的是什么，在最后那条 user 消息里。

于是：回合一长（读了几个文件、跑了几轮命令，工具结果把预算撑满），第 60 行那个从后往前的循环还没走到当前这轮的 user 消息就 `break` 了。结果是——

- 模型看得到**第一轮**的问题（可能是完全无关的旧任务），
- 看得到最近几条工具结果，
- **唯独看不到这一轮到底让它干什么**。

表现就是模型跑着跑着开始答非所问、或者回去做上一轮的事。裁剪本身是为了让长任务能继续跑，结果长任务恰恰是最容易踩中的。

## 期望语义

除了 `messages[0]`，再钉住**最后一条 `role === "user"` 的消息**（下标 ≥ 1 的那些里找最后一条）。

按这个结构改（顺序很重要）：

1. 在循环之前，从后往前找到最后一条 `role === "user"` 且下标 ≥ 1 的消息，记下它的下标 `taskIndex`（找不到就 -1）。
2. 把它的估算开销**提前计入** `used`，跟 `head` 一样待遇——这样预算账是准的，不会因为强行保留而超预算。
3. 循环里遇到 `index === taskIndex` 时，直接 `kept.unshift(...)` 并 `continue`，**不要再加一次开销**（第 2 步已经算过了），也不要让它被预算判断 `break` 掉。
4. 循环里记住实际保留到的最小下标（比如叫 `firstKept`，初值设成 `messages.length`）。
5. **先执行第 73 行那句「尾部不能以工具结果开头」的 while**，再判断：如果 `taskIndex > 0` 且 `firstKept > taskIndex`（说明循环提前 break、任务陈述没进来），就把它 `kept.unshift(...)` 补到最前面。

第 5 步的顺序不能反。理由：那句 while 只检查 `kept[0]`。要是先把任务陈述插到最前面，紧跟其后的那条工具结果就检查不到了，而它对应的 tool_call 已经被裁掉——真实的 OpenAI 兼容服务会直接返回 400。先剥再插，插进去的是 user 消息，不会触发那条规则。

其余行为全部不变：`dropped` 仍然按 `messages.length - kept.length - 1` 算；第 52 行的提前返回、「至少保留最后 4 条」、占位消息的位置都不动。

顺便把第 40 行那句注释改准确（现在写的「第一条消息一定是任务陈述」是错的，多轮会话里不成立）。

## 测试要求

往 `apps/studio/src/bun/agent-compaction.test.ts` 的 `describe("compactMessages", ...)` 里加用例。照第 57 行那条的写法搭场景。

至少覆盖这 3 条：

1. **多轮会话 + 长回合时，当前这一轮的任务陈述仍在结果里**（**这条就是本次要修的缺陷，改之前必须是红的**）。
   场景这么造：第 1 条是 `message("user", "第一轮的老问题")`；中间塞十几条别的；然后放一条 `message("user", "这一轮：把导出做完")`；**再往后塞 30 条很长的 assistant / toolResult 消息**把预算撑爆。断言结果里能找到「这一轮：把导出做完」这条。
   注意：中间那十几条**不要用 user 角色**，否则「最后一条 user」就不是你想钉的那条了。
2. **`messages[0]` 仍然保留**，占位消息仍在第 2 位（防止改过头把原有行为改坏）。
3. **尾部仍然不会以工具结果开头**：把场景造成「任务陈述之后紧跟一串 toolResult」，断言结果里任务陈述后面那条不是 toolResult 开头的悬空结果——直接断言 `result.messages` 里不存在「role 为 toolResult 且它前面那条是任务陈述」的情况即可。

`message()` 这个辅助函数测试文件顶部已经有了，直接用。

## 验收标准（汇报第 5 节逐条填）

- [ ] 最后一条 user 消息被钉住，长回合里不会被裁掉
- [ ] 它的开销提前计入 `used`，预算账没有重复计算
- [ ] 「先剥尾部工具结果、再插任务陈述」的顺序没弄反
- [ ] `messages[0]`、占位位置、「至少保留最后 4 条」、`dropped` 的算法都没变
- [ ] 没有动 `pruneSupersededReads`
- [ ] 第 40 行那句注释已改准确
- [ ] 现有 14 条用例一条没删没改，全绿
- [ ] 把 `agent-compaction.ts` 的改动还原后，第 1 条用例会变红（你自己先试一遍）
- [ ] 源码改动不超过 30 行

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/12-pin-current-task.json
```

输出原样贴进汇报第 4 节。
