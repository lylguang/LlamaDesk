# 任务 05：停止信号传不到子智能体（`task` 工具把它丢了）

工作树根目录：`/home/xixi/Git/OmniStudio/.claude/worktrees/agent-optimize`

## 允许改动的文件（只有这三个）

1. `apps/studio/src/bun/agent-tools.ts` —— 只许改 `ToolContext` 里 `spawnSubagent` 的类型，与 `task` 工具的 `execute`
2. `apps/studio/src/bun/agent.ts` —— 只许改 `spawnSubagent` 的注入（第 921 到 930 行）与 `runSubagent`（第 1514 行起）
3. `apps/studio/src/bun/agent-subagent-stop.test.ts` —— 你要新建的测试文件

别的文件一个都不许碰。两个源码文件都很大，**不要通读**，按行号定位。

## 现状

`task` 工具的 `execute` 拿到了内核给的中止信号，但**第 1288 行直接把它丢掉**：

```
1285        signal?: AbortSignal,
1286      ) => {
1287        if (!ctx.spawnSubagent) return errorResult("Subagents are not available in this mode.");
1288        void signal;
```

`spawnSubagent` 的类型（第 61 到 65 行）也没有接收信号的位置：

```
61    spawnSubagent?: (opts: {
62      description: string;
63      prompt: string;
64      subagentType: string;
65    }) => Promise<string>;
```

`agent.ts` 第 921 到 930 行注入它时同样没传；`runSubagent`（第 1514 行起）的入参里也没有。

## 缺陷

用户按停止之后，**子智能体还在跑**：它自己的工具调用（读文件、跑命令、写文件）会继续执行到自然结束。

已经修掉的一半：`makeContextTransform` 现在会在下一次模型调用前抛中止错（第 04b 条），而子智能体传进去的 `conversationId` 是父会话的，所以**下一次模型调用**会被拦。

**没修的一半**：拦住的是「下一次问模型」，拦不住「这一轮已经决定要跑的工具」。子智能体正在跑 `bash` 或 `write_file` 时按停止，那条命令照样跑完。

## 期望语义

把中止信号一路传到子智能体的内核，让它自己的工具执行也被打断。

**改三处**：

1. **`agent-tools.ts` 第 61 到 65 行**，给 `spawnSubagent` 的入参加一个可选信号：

   ```
     spawnSubagent?: (opts: {
       description: string;
       prompt: string;
       subagentType: string;
       signal?: AbortSignal;
     }) => Promise<string>;
   ```

2. **`agent-tools.ts` 第 1288 行**：删掉 `void signal;`，改成把信号传下去——

   ```
         const summary = await ctx.spawnSubagent({
           description: params.description,
           prompt: params.prompt,
           subagentType,
           signal,
         });
   ```

   （原来那几个字段照抄，只多加 `signal`。）

3. **`agent.ts` 第 921 到 930 行**的注入照抄透传（`...opts` 里已经带上了 `signal`，确认类型对得上就行），并在 **`runSubagent`**（第 1514 行）的入参类型里加 `signal?: AbortSignal;`。

   在 `runSubagent` 里，第 1574 行 `new Agent({...})` 之后、第 1688 行 `await agent.prompt(...)` 之前，把父信号接到子 agent 上：

   ```
     // 父回合被中止时连子智能体一起停：否则用户按了停止，子智能体正在跑的
     // bash / write_file 还会执行到自然结束。
     if (opts.signal) {
       if (opts.signal.aborted) agent.abort();
       else opts.signal.addEventListener("abort", () => agent.abort(), { once: true });
     }
   ```

   注意两点：**已经中止的信号不会再触发事件**，所以要先判一次 `aborted`；监听器加 `once: true`，别让它累积。

## 不要做的事

- 不要动 `makeContextTransform`（04b 刚改过）
- 不要动 `beforeToolCall` 里的授权逻辑
- 不要动 `runSubagent` 的事件记录（`subagent_start` / `subagent_end`）与返回文本
- 不要给子智能体单独建 `stopRequests` 之类的新状态

## 测试要求

新建 `apps/studio/src/bun/agent-subagent-stop.test.ts`。照 `agent-stop-startup.test.ts` / `agent-turn.test.ts` 的写法搭架子（起桩、`updateSettings`、建会话、跑回合）。

场景：让桩服务先让**主** agent 调 `task` 派一个子智能体，子智能体那边再让桩返回一个 `bash` 工具调用（跑一条能看出有没有被打断的命令，比如往工作区写个文件再 sleep）。在子智能体跑起来之后调 `Agent.stopAgentRun(conversationId)`。

至少覆盖这 2 条：

1. **停止之后子智能体不再发起新的模型请求**：数桩服务收到的请求次数，停止后不再增长。（这一半 04b 已经保证，这条算回归保护。）
2. **停止能打断子智能体正在跑的工具**（**这条是本次要修的缺陷**）：用一个可观测的信号——比如让子智能体跑 `bash` 写一个「开始标记」文件、sleep 几秒、再写一个「结束标记」文件；停止之后断言开始标记在、**结束标记不在**。

第 2 条如果构造不稳（时序太紧），改成断言「工具调用被中止」的其它可观测证据也行，但**必须是能区分「被打断」和「跑完了」的硬证据**，不能只断言返回文案。

如果这套时序实在搭不起来，**不要用 sleep 硬赌、不要改源码绕过**，在汇报第 6 节写清你试了什么、观察到什么。

## 验收标准（汇报第 5 节逐条填）

- [ ] `spawnSubagent` 类型加了可选信号，`task` 工具不再丢弃它
- [ ] `runSubagent` 接收信号并接到子 agent 上
- [ ] 已经中止的信号也能生效（先判 `aborted`）
- [ ] 监听器用了 `once: true`
- [ ] 上面「不要做的事」一项没动
- [ ] 第 2 条用例用的是能区分「被打断」与「跑完了」的硬证据
- [ ] 把两个源码文件的改动还原后，第 2 条用例会变红（你自己先试一遍）
- [ ] 源码改动（两个文件合计）不超过 25 行

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/05-subagent-stop-signal.json
```

输出原样贴进汇报第 4 节。
