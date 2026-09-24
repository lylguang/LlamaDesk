# 任务 06：失败的回合仍然返回 `ok: true`，命令行退出码与自动化状态都失真

工作树根目录：`/home/xixi/Git/OmniStudio/.claude/worktrees/agent-optimize`

## 允许改动的文件（只有这两个）

1. `apps/studio/src/bun/agent.ts` —— 源码，**只许改 `runAgentTurn` 的收尾返回值那一段**（第 3035 到 3036 行附近），外加在第 2840 行附近记一个变量
2. `apps/studio/src/bun/agent-turn.test.ts` —— 你要新建的测试文件

别的文件一个都不许碰。`agent.ts` 有 3300 多行，**不要通读它**，按下面给的行号定位。

## 现状

第 2840 行把这一轮的结果分类：

```
2840    const outcome = classifyTurnOutcome({ ... });
```

`classifyTurnOutcome` 的取值见 `apps/studio/src/bun/agent-outcome.ts` 第 13 到 20 行：`ok` / `empty` / `aborted` / `error`。

第 2857 行起处理 `error`：

```
2857      } else if (outcome.kind === "error") {
2858        recordEvent({ ... kind: "error", output: outcome.detail });
```

往后还会记一条统一日志，并把 `⚠️ <detail>` 追加到正文里。

但函数收尾（第 3035 到 3036 行）是：

```
3035    if (hookBlockedReason) return { ok: false, error: hookBlockedReason };
3036    return { ok: true };
```

**除了被 hook 拦下这一种，其它一律返回 `ok: true`。**

## 缺陷

`outcome.kind === "error"` 意味着这一轮真的失败了（模型报错、传输层重试耗尽、服务端返回错误等），界面上会看到一条 ⚠️。但返回给调用方的是「成功」。

调用方被这个值骗了：`apps/studio/src/bun/agent-headless.ts` 第 135 行：

```
135      if (!turn.ok && turn.error) error = turn.error;
```

`ok` 永远是 true，所以 `error` 永远拿不到；再往下第 151 行：

```
151      ok: !error,
```

于是无头运行（`omi agent run`、自动化任务）对一个失败的回合**报告成功、退出码 0**。用户在脚本里串 `omi agent run && 下一步`，失败了也会继续往下走。

## 期望语义

`outcome.kind === "error"` 时，`runAgentTurn` 返回 `{ ok: false, error: outcome.detail }`。

做法：

1. 在第 2840 行那个 `const outcome = ...` **之前**，于函数作用域里加一个变量，比如：

   ```
   /** 这一轮的失败原因（outcome 为 error 时填）：收尾时要如实返回给调用方。 */
   let turnError: string | null = null;
   ```

   注意 `outcome` 是在一个内层块里用 `const` 声明的，收尾处拿不到它，所以必须用外层变量把详情带出来。

2. 第 2857 行那个 `else if (outcome.kind === "error")` 分支里，**在现有逻辑之外**补一句 `turnError = outcome.detail;`。分支里原有的 `recordEvent`、日志、追加 `⚠️` 到正文，一律不动。

3. 收尾改成：

   ```
   if (hookBlockedReason) return { ok: false, error: hookBlockedReason };
   if (turnError) return { ok: false, error: turnError };
   return { ok: true };
   ```

   顺序很重要：hook 拦下那条要留在最前面（它的原因更具体）。

**不要动**的：`aborted` 分支（用户主动停止不算失败）、`empty` 分支（空回合有自己的提示，不是错误）、`agent-headless.ts`、`automations.ts`、界面。

## 测试要求

新建 `apps/studio/src/bun/agent-turn.test.ts`。

**这是第一个用新桩服务跑真回合的单测**，工具在 `apps/studio/src/bun/test-stub-llm.ts`，导出 `startStubLlm` / `textChunks` / `toolCallChunks` / `sseChunk`。用法照 `apps/studio/scripts/agent-resilience-smoke.ts` 第 400 行往后那段（起桩 → `updateSettings` 指向它 → 调 `Agent.runAgentTurn`）。

要点：

- 桩服务对 chat completions **一直返回 HTTP 500**（或别的能让传输层重试耗尽的错误），这样这一轮必然以 `error` 收尾。
- `updateSettings` 里把 `AGENT_RETRY_MAX` 设小（比如 `"1"`），别让重试把用例拖长。
- 别忘了设 `SETUP_COMPLETE` / `SERVER_MODE: "remote"` / `VLLM_API_BASE`（桩的 base）/ `VLLM_MODEL_NAME` / `CHAT_MODEL`，否则 `runAgentTurn` 会在第 2413 到 2439 行的前置检查里提前返回，**根本走不到我们要测的地方**（这一点很关键，前置检查返回的也是 `ok: false`，容易造出一个假绿用例）。
- 会话要先建出来（看冒烟脚本怎么建的）。
- 用例结束记得 `stub.stop()`。

至少覆盖这 3 条：

1. **模型持续报错时，`runAgentTurn` 返回 `ok: false` 且 `error` 非空**（**这条就是本次要修的缺陷，改之前会是 `ok: true`**）。
2. **正常成功的回合仍然返回 `ok: true`**：桩服务正常吐一段文本，断言 `ok: true`、没有 `error`。这条防止改过头把成功也判成失败。
3. **失败那一轮的轨迹里仍然有那条 error 事件**，且正文里仍带 `⚠️`——证明我们只是补了返回值，没有动原有的用户可见行为。

如果在 `bun test` 环境里起桩或跑回合遇到障碍（数据目录隔离、模块加载时序等），**不要硬凑也不要改源码绕过**，在汇报第 6 节写清卡在哪、报什么错，我来定怎么办。

## 验收标准（汇报第 5 节逐条填）

- [ ] `error` 收尾时返回 `ok: false` 并带上 `outcome.detail`
- [ ] hook 拦下那条仍排在最前
- [ ] `aborted` / `empty` 两个分支没动
- [ ] 原有的 `recordEvent`、日志、正文追加 `⚠️` 都没动
- [ ] 没有动 `agent-headless.ts` / `automations.ts` / 界面
- [ ] 成功回合仍返回 `ok: true`
- [ ] 用例确实走到了回合内部（不是被前置检查挡回来的假绿）
- [ ] 把 `agent.ts` 的改动还原后，第 1 条用例会变红（你自己先试一遍）
- [ ] 源码改动不超过 12 行

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/06-failed-turn-returns-ok.json
```

输出原样贴进汇报第 4 节。
