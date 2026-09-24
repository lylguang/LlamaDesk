# 任务 04a：启动窗口里能并发起第二轮（会话重入没有闸门）

工作树根目录：`/home/xixi/Git/OmniStudio/.claude/worktrees/agent-optimize`

## 允许改动的文件（只有这两个）

1. `apps/studio/src/bun/agent.ts` —— 源码，只许改下面点明的四处
2. `apps/studio/src/bun/agent-reentry.test.ts` —— 你要新建的测试文件

别的文件一个都不许碰。`agent.ts` 有 3300 多行，**不要通读它**，按行号定位。

## 现状

`runAgentTurn` 的运行标记要到第 2562 行才置上：

```
2562    setAgentRunning(conversationId, true);
```

而它之前有两处异步等待：

```
2446      const ready = await ensureServerReady();      // 本地模式：拉起推理服务，可能几十秒
2491    const session = await getOrCreateSession(conversationId, mode, workspace, opts.headless === true);
```

判断「在不在跑」的是第 1163 行：

```
1163  export function isAgentRunning(conversationId: number): boolean {
1164    return running.has(conversationId);
1165  }
```

两个地方靠它做守卫：

```
3062    if (isAgentRunning(opts.conversationId)) return;        // maybeContinueGoal
3136    if (!isAgentRunning(opts.conversationId)) {             // followUpAgentMessage：不在跑就直接起一轮
```

## 缺陷

第 2446 与 2491 两处 await 之间，`running` 里还没有这个会话，`isAgentRunning` 返回 false。

于是这段窗口里：

- 用户再发一条消息 → 第 3136 行判定「没在跑」→ **直接起第二个 `runAgentTurn`**，两轮并发跑同一个会话，共用同一个 Agent 实例与同一批模块级状态；
- Goal 模式的自动续跑（第 3062 行）同样会挤进来。

本地模式下这个窗口尤其长——`ensureServerReady` 要拉起推理服务、等模型加载，几十秒都可能。用户看到界面还没进入「运行中」，再按一次发送就重入了。

**关键事实**：第 2380 到 2445 行之间**没有任何 await**（我逐行确认过），所以重入窗口精确地从第 2446 行开始。第 2401、2412、2425、2441 行那四处提前返回都在同步段里，不可能被重入。

## 期望语义

加一个「启动中」标记，让 `isAgentRunning` 在启动段也返回 true。这样两个调用点一个字都不用改：`followUpAgentMessage` 会走排队，`maybeContinueGoal` 会跳过。

**改这四处**：

1. **第 1161 行附近**，紧挨 `const running = new Set<number>();` 加一个：

   ```
   /**
    * 已进入 `runAgentTurn`、但还没走到 `setAgentRunning(true)` 的会话。
    *
    * 启动段有两处 await（拉起推理服务、建会话），本地模式下能长达几十秒。
    * 不把这段算进「在跑」，用户再发一条就会并发起第二轮 —— 两轮共用同一个
    * Agent 实例与同一批模块级状态。
    */
   const starting = new Set<number>();
   ```

2. **第 1163 到 1165 行** `isAgentRunning` 改成 `return running.has(conversationId) || starting.has(conversationId);`

3. **第 2444 行之前**（也就是第一处 await 之前、`if (getSetting("SERVER_MODE") === "local")` 那一行上面）加 `starting.add(conversationId);`，并写一行注释说明「从这里开始有 await，必须先占位」。

4. **三处清除**，一个都不能漏：
   - 第 2457 行那个 `return { ok: false, error };`（推理服务没就绪）之前 —— 这是启动段唯一一处提前返回；
   - 第 2562 行 `setAgentRunning(conversationId, true);` 之后紧跟一行 `starting.delete(conversationId);`；
   - 第 2928 行那个 `finally` 块里，紧挨 `setAgentRunning(conversationId, false);` 再加一行 `starting.delete(conversationId);` —— 兜底，防止主体里抛异常时残留。

**漏掉任何一处清除，会话就会永久显示「在跑」，输入框永久禁用。** 这是这条改动唯一的危险，请逐条核对。

## 不要做的事

- 不要动第 3136 行与第 3062 行那两个调用点（改 `isAgentRunning` 就够了）
- 不要动第 2537 行那句 `stopRequests.delete(conversationId)`（启动期按停止被擦掉是另一条任务）
- 不要动 `setAgentRunning` 的推送逻辑
- 不要给 `starting` 加对外导出

## 测试要求

新建 `apps/studio/src/bun/agent-reentry.test.ts`。照 `apps/studio/src/bun/agent-turn.test.ts` 与 `agent-queue.test.ts` 的写法搭架子（起桩、`updateSettings`、建会话、跑回合）。

**命中启动窗口的办法**：让桩服务**第一次请求先卡住不返回**（等一个你自己控制的 promise），这样第一轮会停在等模型响应那一步。但注意——那已经过了第 2562 行，`running` 里有了，测不到启动窗口。

所以要卡在**更早**的地方。可行做法：`SERVER_MODE` 设成 `"local"`，让第 2446 行的 `ensureServerReady()` 成为卡点。如果它不好控制，改用另一条路：**不 await 第一个 `runAgentTurn`，紧接着同一个微任务里就调 `followUpAgentMessage`**——此时第一轮连第一处 await 都还没返回，`running` 必然还是空的。这条最稳，优先试它。

至少覆盖这 2 条：

1. **启动窗口里再发消息会被排队，不会起第二轮**（**这条就是本次要修的缺陷**）：断言 `followUpAgentMessage` 返回 `queued: true`。改之前它会返回 `queued: false`（因为被当成「没在跑」直接跑了一轮）。
2. **回合正常收尾后，会话不再显示「在跑」**：跑完一个完整回合，断言 `Agent.isAgentRunning(conversationId)` 为 false。**这条专门防上面说的那个危险**——漏清除会让它永久为 true。

如果时序实在命不中，**不要用 sleep 硬赌、也不要改源码绕过**，在汇报第 6 节写清你试了哪几种办法、各自的现象。

## 验收标准（汇报第 5 节逐条填）

- [ ] `starting` 已加，`isAgentRunning` 把它算进去
- [ ] 占位加在第一处 await 之前
- [ ] 三处清除全部落实（提前返回、置位之后、finally 兜底）—— 逐条列出你加在哪一行
- [ ] 第 3136 / 3062 两个调用点没动
- [ ] 第 2537 行那句没动
- [ ] 用例 2 证明跑完之后运行态确实回落
- [ ] 把 `agent.ts` 的改动还原后，第 1 条用例会变红（你自己先试一遍）
- [ ] 源码改动不超过 25 行

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/04a-reentrancy-gate.json
```

输出原样贴进汇报第 4 节。
