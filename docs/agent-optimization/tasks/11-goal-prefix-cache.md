# 任务 11：Goal 模式把每轮都在变的进度写进系统提示，前缀缓存每轮全作废

工作树根目录：`/home/xixi/Git/OmniStudio/.claude/worktrees/agent-optimize`

## 允许改动的文件（只有这两个）

1. `apps/studio/src/bun/agent-goals.ts` —— 源码，只许改 `goalPromptSection` 和 `goalContinuationText` 这两个函数
2. `apps/studio/src/bun/agent-goals.test.ts` —— 既有测试文件，**只许加用例，现有 14 条一条都不许删、不许改**

别的文件一个都不许碰。特别注意：**不要动 `describeGoal`**，界面和 `goal` 工具的 get 操作都在用它，它带进度是对的。

## 现状

`apps/studio/src/bun/agent-goals.ts` 第 201 到 221 行，`goalPromptSection` 拼的是**系统提示**里的目标段落。其中第 209 行：

```
209      `**进度**：${describeGoal(goal)}`,
```

而 `describeGoal`（第 187 到 193 行）拼的内容是：

```
188      const parts = [`目标：${goal.objective}`, `状态：${goal.status}`];
189      parts.push(goal.tokenBudget ? `已用 ${goal.tokensUsed} / ${goal.tokenBudget} tokens` : `已用 ${goal.tokensUsed} tokens`);
190      if (goal.secondsUsed > 0) parts.push(`已运行 ${Math.round(goal.secondsUsed / 60)} 分钟`);
191      parts.push(`自动续跑 ${goal.continuations} / ${maxGoalContinuations()} 次`);
```

已用 token、已运行分钟数、续跑次数——**每一轮都在变**。

## 缺陷

`apps/studio/src/bun/agent.ts` 第 2711 到 2719 行每轮重建系统提示，并且特意写了只有内容真变了才写回，注释原话是：

```
2712      // 可能在上几轮里变了。只有内容真的变了才写回 —— 系统提示是请求里最靠前的部分，
2713      // 无谓地重写会让后端的前缀缓存整段作废（内容里的时间提醒已挪到本轮用户消息）。
```

也就是说，这套设计**本来就是为了保住前缀缓存**，时间提醒这类易变内容都已经挪到本轮用户消息里去了。

但 Goal 模式下，第 2715 行拼进来的 `goalPromptSection(conversationId)` 里带着上面那行进度，于是系统提示每轮都不一样 → 每轮都写回 → **前缀缓存每一轮全部作废**。系统提示是请求里最靠前、最长的一段，Goal 模式又是会自动跑很多轮的模式，这个浪费是持续的。

## 期望语义

**第一处：`goalPromptSection` 去掉进度行。**

把第 209 行整行删掉。段落里其余内容（目标、验收标准、那几条完成标准）一个字都不要动——它们是稳定的，现有用例也在钉着。

去掉之后，同一个目标在用量变化前后，`goalPromptSection` 的返回值应当**逐字节相同**。

**第二处：`goalContinuationText` 补上进度。**

`goalContinuationText`（第 224 到 232 行）是自动续跑时当作**用户消息**推给模型的内容——用户消息在请求靠后的位置，每轮本来就不一样，放易变内容不影响前缀缓存。

在它返回的那几行里加一行进度，用 `describeGoal(goal)`。位置放在「接着推进」那句之后、验收标准那句之前。

这样模型仍然每轮都知道预算用到哪了（系统提示里那句「预算快用完了不等于任务完成了」才有对应的事实支撑），但易变内容挪到了缓存友好的位置。

模型另外还能随时用 `goal` 工具的 get 操作查进度，那条路径也没动。

## 测试要求

往 `apps/studio/src/bun/agent-goals.test.ts` 的 `describe("注入与文案", ...)` 里加用例。

至少覆盖这 3 条：

1. **用量变化不改变 `goalPromptSection` 的返回值**：立一个目标，取一次段落；调 `addGoalUsage` 记一笔用量（token、秒数、续跑次数都要变）；再取一次段落；两次结果 `toBe` 相等。
   （**这条就是本次要修的缺陷，改之前必须是红的**。）
2. **段落里不含那几个易变字样**：断言不含 `tokens`、不含 `分钟`、不含 `自动续跑`。
3. **续跑消息里含进度**：`goalContinuationText` 的结果里能看到用量数字和续跑次数。

`addGoalUsage` 的用法照现有第 155 行那条用例抄。

## 验收标准（汇报第 5 节逐条填）

- [ ] `goalPromptSection` 去掉了进度行，其余内容一字未动
- [ ] 用量变化前后段落逐字节相同
- [ ] `goalContinuationText` 加上了进度
- [ ] `describeGoal` 没动
- [ ] 现有 14 条用例一条没删没改，全绿
- [ ] 把 `agent-goals.ts` 的改动还原后，第 1 条用例会变红（你自己先试一遍）
- [ ] 源码改动不超过 15 行

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/11-goal-prefix-cache.json
```

输出原样贴进汇报第 4 节。
