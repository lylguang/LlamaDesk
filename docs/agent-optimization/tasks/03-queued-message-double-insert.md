# 任务 03：排队的用户消息被写进数据库两次

工作树根目录：`/home/xixi/Git/OmniStudio/.claude/worktrees/agent-optimize`

## 允许改动的文件（只有这两个）

1. `apps/studio/src/bun/agent.ts` —— 源码，**只许改 `drainQueuedMessages` 里那一行调用**（第 3191 行）
2. `apps/studio/src/bun/agent-queue.test.ts` —— 你要新建的测试文件

别的文件一个都不许碰。`agent.ts` 有 3300 多行，**不要通读它**，按下面给的行号定位。

## 现状

用户在回合运行中再发消息，走 `followUpAgentMessage`。排队那一支先把消息写进库（第 3148 行起）：

```
3148    db.insert(messages)
3149      .values({ conversationId: opts.conversationId, role: "user", content })
3150      .run();
```

注释写的是「落库：实时上下文与历史都必须能看到这条消息」。

本次运行结束后由 `drainQueuedMessages` 逐条跑掉（第 3184 行起）：

```
3191      const result = await runAgentTurn({ conversationId, content: next!, workspace });
```

而 `runAgentTurn` 自己也会插一条（第 2467 行起）：

```
2467    if (opts.insertUserMessage !== false) {
2468      db.insert(messages)
```

## 缺陷

同一条排队消息**入库两次**：入队时一次，出队跑回合时又一次。

结果是会话里出现两个一模一样的用户气泡；更要紧的是**模型在历史和本轮提问里各看到它一遍**，等于同一句话被说了两遍。

这个坑在同一个文件里已经被踩过一次并修好了——第 3270 到 3276 行，重新生成那条路径：

```
3270    // `insertUserMessage: false`：那条用户消息排在目标回答之前、不在删除区间内，
3271    // 库里已经有了。不传这句 `runAgentTurn` 会默认再插一条 —— 每次重新生成都会多出
3272    // 一个一模一样的用户气泡，模型侧还会在历史与 prompt 里各看到它一遍。
...
3276      insertUserMessage: false,
```

注释把后果讲得一字不差，但排队这条路径漏了同一个参数。

## 期望语义

第 3191 行那个调用补上 `insertUserMessage: false`：

```
      const result = await runAgentTurn({
        conversationId,
        content: next!,
        workspace,
        insertUserMessage: false,
      });
```

并在上面加一行注释，说明这条消息在入队时（`followUpAgentMessage`）就已经落库了，照第 3270 行那段的口径写。

**别的一律不动**：入队那次插库保留（实时上下文要看到它）、`pendingMessages` 的出队逻辑、`if (!result.ok) return;`、`steer` 那一支，全都不许改。

## 测试要求

新建 `apps/studio/src/bun/agent-queue.test.ts`。

**用桩推理服务在单测里真跑回合**，工具在 `apps/studio/src/bun/test-stub-llm.ts`。**照 `apps/studio/src/bun/agent-turn.test.ts` 的写法搭架子**——那个文件刚写好，起桩、`updateSettings`、建会话、调 `Agent.runAgentTurn` 的整套都在里面，直接抄。

场景：

1. 起一个正常应答的桩（吐一段文本就行）。
2. 建会话，发起第一个回合，**不要等它结束**。
3. 在它还在跑的时候调 `Agent.followUpAgentMessage({ conversationId, content: "第二条", mode: "queue" })`。
4. 等第一个回合与排队那一轮都结束。
5. 查库里 `role: "user"` 且内容为「第二条」的消息有几条。

拿到运行中状态的办法：`Agent.runAgentTurn(...)` 返回的是 Promise，先不 await，拿到句柄后再调 `followUpAgentMessage`，最后一起 await。若时序不稳（第一轮太快就结束了），可以让桩在应答前延时一点——**但不要用固定 sleep 去赌**，想办法让桩自己控制节奏（比如第一次请求先等一个 promise 再吐）。

至少覆盖这 2 条：

1. **排队的那条用户消息在库里只有一条**（**这条就是本次要修的缺陷，改之前会是两条**）。
2. **排队那一轮确实跑起来了**：断言助手回复有两条（第一轮 + 排队那轮），或者用别的方式证明第二轮真的执行了。这条防止「因为排队根本没跑所以只有一条」的假绿。

第 2 条很重要：如果只断言「只有一条用户消息」，那么一个「排队功能彻底坏掉」的版本也会通过。

如果时序实在不稳定，**不要用 sleep 硬凑、也不要改源码**，在汇报第 6 节写清卡在哪，我来定怎么办。

## 验收标准（汇报第 5 节逐条填）

- [ ] 第 3191 行补上了 `insertUserMessage: false`，并加了注释说明理由
- [ ] 入队那次插库仍然保留
- [ ] `pendingMessages` 出队逻辑、`if (!result.ok) return;`、`steer` 那一支都没动
- [ ] 用例证明排队那一轮真的跑了（不是靠「没跑」凑出的假绿）
- [ ] 把 `agent.ts` 的改动还原后，第 1 条用例会变红（你自己先试一遍）
- [ ] 源码改动不超过 8 行

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/03-queued-message-double-insert.json
```

输出原样贴进汇报第 4 节。
