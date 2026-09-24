# 任务 04b：启动期按下的「停止」被擦掉，回合照样发请求

工作树根目录：`/home/xixi/Git/OmniStudio/.claude/worktrees/agent-optimize`

## 允许改动的文件（只有这两个）

1. `apps/studio/src/bun/agent.ts` —— 源码，只许改下面点明的地方
2. `apps/studio/src/bun/agent-stop-startup.test.ts` —— 你要新建的测试文件

别的文件一个都不许碰。`agent.ts` 有 3300 多行，**不要通读它**，按行号定位。

## 现状

`stopAgentRun`（第 3246 行）按下停止时记一个标记：

```
3246    stopRequests.add(conversationId);
3247    const session = sessions.get(conversationId);
3248    if (!session) return { ok: false };
```

注意：会话还没建出来时（第 3248 行）它返回 `ok: false`，但**标记已经记上了**。

而 `runAgentTurn` 在第 2551 行把这个标记清掉：

```
2551    stopRequests.delete(conversationId);
```

这一行在启动段的两处 await **之后**（第 2459 行拉推理服务、第 2504 行建会话）。

标记的消费点只有两处，都在第一次请求**之后**：

```
2798          const stopped = () => stopRequested || stopRequests.has(conversationId);
2801            if (attempt === 0) await agent.prompt(prompt);
2803            if (attempt >= retryLimit || stopped()) return;
2840            if (stopped()) return;
```

## 缺陷

用户在启动期按停止（本地模式下拉起推理服务可能几十秒，界面上正显示「处理中」）：

1. `stopAgentRun` 记下标记；
2. `runAgentTurn` 从 await 里醒来，第 2551 行**把标记删掉**；
3. 回合当作什么都没发生，照常发出第一次请求。

用户按了停止，模型照样跑。

第 2551 行本身是有道理的——新回合不该继承上一轮残留的标记。问题是它**放在了 await 之后**，把「这一轮启动期间新按的停止」和「上一轮的残留」混为一谈了。

## 期望语义

**两件事都要做到**：

**一、清除挪到同步段。**
把第 2551 行那句 `stopRequests.delete(conversationId)` 移到函数开头的同步段里——放在 `starting.add(conversationId);`（第 2455 行附近）**之前**。

那之前全是同步代码（我逐行确认过，第 2380 到 2445 行没有任何 await），所以在那里清除只会清掉上一轮的残留，不可能清掉本轮启动期新按的停止。原位置那一行删掉。

**二、启动期按下的停止要真的拦住请求。**
光保住标记还不够：消费点都在 `agent.prompt()` **之后**，第一次请求照样会发出去。

建议做法（你自己验证行不行）：在第 2504 行 `getOrCreateSession` 拿到 `session` 之后，加一句——

```
  // 启动期按下的停止：会话刚建好才有 abort 目标，这里补一刀。
  // 光留着标记不够 —— stopped() 只在 prompt 返回之后才检查，第一次请求照样会发出去。
  if (stopRequests.has(conversationId)) session.agent.abort();
```

思路是让内核的信号在发请求之前就处于已中止状态，`agent.prompt()` 直接抛中止错误，落进第 2920 行那个 catch，走已有的「已停止」收尾路径（那里会把 `aborted` 置上、正文写「已停止」）。

**如果这个做法不成立**（比如 `prompt()` 会重置信号、或者抛的不是中止类错误），**不要硬凑、不要改 pi-agent-core 的调用契约**，在汇报第 6 节写清你试了什么、观察到什么，我来定下一步。这一条允许只完成第一件事、第二件事留着，前提是你如实说明。

## 不要做的事

- 不要动 `stopAgentRun` 本身
- 不要动第 2952 行 `finally` 里那句 `stopRequests.delete`
- 不要动第 2798 / 2803 / 2840 那三处消费点
- 不要动 `starting` 那一套（04a 刚做完）

## 测试要求

新建 `apps/studio/src/bun/agent-stop-startup.test.ts`。照 `agent-turn.test.ts` / `agent-reentry.test.ts` 的写法搭架子。

**关键断言是「桩服务收到了几次 chat completions 请求」**——这是唯一能证明「请求真的没发出去」的硬指标。桩工具的 `respond` 回调每次收到请求都会被调用，自己在闭包里数一下即可。

至少覆盖这 3 条：

1. **启动期按停止 → 桩服务一次请求都没收到**（**这条就是本次要修的缺陷，改之前会收到 1 次**）。
   命中启动窗口的办法：不 await `runAgentTurn`，同一个微任务里紧接着调 `Agent.stopAgentRun(conversationId)`，然后再 await 那个回合。
2. **上一轮的残留标记不会拖累下一轮**：先按一次停止（不跑回合），再正常跑一个回合，断言这一轮正常完成、桩收到了请求。这条防止把清除挪早之后又走向另一个极端。
3. **跑完之后运行态回落**：`Agent.isAgentRunning(conversationId)` 为 false。04a 那条危险（永久显示在跑）在这条改动里同样存在，要一起守住。

## 验收标准（汇报第 5 节逐条填）

- [ ] 清除已挪到同步段，原位置那行已删
- [ ] 启动期按下的停止能拦住第一次请求（或：照实说明为什么做不到）
- [ ] 上一轮残留不会拖累下一轮
- [ ] `stopAgentRun`、`finally` 里的清除、三处消费点、`starting` 那一套都没动
- [ ] 跑完之后运行态回落
- [ ] 把 `agent.ts` 的改动还原后，第 1 条用例会变红（你自己先试一遍）
- [ ] 源码改动不超过 15 行

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/04b-stop-during-startup.json
```

输出原样贴进汇报第 4 节。
