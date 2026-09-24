# 任务 19：bash 超时写死 120 秒，模型和用户都改不了

工作树根目录：`/home/xixi/Git/OmniStudio/.claude/worktrees/agent-optimize`

## 允许改动的文件（只有这两个）

1. `apps/studio/src/bun/agent-tools.ts` —— 源码，只许改 `createBash` 这一个函数，外加在常量区加一个常量
2. `apps/studio/src/bun/agent-tools.bash.test.ts` —— 既有测试文件，**只许加用例，现有 4 条一条都不许删、不许改**

别的文件一个都不许碰。

## 现状

`apps/studio/src/bun/agent-tools.ts`：

第 141 行定义了默认超时：

```
141  const COMMAND_TIMEOUT_MS = 120_000;
```

第 68、69 行在 `ToolContext` 上留了一个覆盖口子：

```
68    /** bash 命令超时（毫秒），默认 120 秒；测试 / 特殊场景可以调小。 */
69    commandTimeoutMs?: number;
```

第 795 行读它：

```
795        const timeoutMs = ctx.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
```

第 780 到 782 行，bash 工具的参数表只有一个 `command`：

```
780      parameters: Type.Object({
781        command: Type.String({ description: "Shell command to execute." }),
782      }),
```

## 缺陷

`commandTimeoutMs` 这个口子**全仓库没有任何地方设置它**（除了测试）。也就是说实际生效的永远是写死的 120 秒。

后果：跑一次完整测试套件、装一次依赖、编译一个大项目——这些正常情况下就要几分钟的命令，一律在 120 秒被连同子进程一起杀掉。模型拿到的是第 840 到 841 行那句「命令超过 120 秒，已连同子进程一起终止」，然后它**无能为力**：参数表里没有可以调超时的地方，它只能换个更短的命令、或者反复重试同一条注定超时的命令。

## 期望语义

给 bash 工具加一个**可选**参数 `timeout_ms`，让模型自己按命令性质决定。

1. 在常量区（第 141 行那句旁边）加上限常量：

   ```
   /** 模型可以要求的最长超时：再长就该换成后台任务，别把一个回合挂在这里。 */
   const MAX_COMMAND_TIMEOUT_MS = 600_000;
   ```

2. 参数表加一项：

   ```
   timeout_ms: Type.Optional(
     Type.Number({ description: "Milliseconds before the command is killed. Default 120000, max 600000. Raise it for full test suites, installs, and builds." }),
   ),
   ```

   `execute` 的入参类型也要跟着加 `timeout_ms?: number`。

3. 第 795 行那句改成：传了 `timeout_ms` 且是**有限正数**时，取它并夹到 `[1000, MAX_COMMAND_TIMEOUT_MS]` 区间；没传、或传了 `NaN` / 0 / 负数 / `Infinity` 这类非法值，退回原来的 `ctx.commandTimeoutMs ?? COMMAND_TIMEOUT_MS`。

4. 工具描述（第 777 到 779 行）补一句，告诉模型跑测试套件、装依赖、编译这类命令可以调高 `timeout_ms`。**原有那两句不要删**，接在后面。

5. 第 840 到 841 行那句超时提示不用改——它本来就是按实际生效的 `timeoutMs` 算秒数的，自动会显示新值。

`ctx.commandTimeoutMs` 那条路**保留不动**，测试还在用它。优先级是：`timeout_ms` 参数 > `ctx.commandTimeoutMs` > `COMMAND_TIMEOUT_MS`。

## 不要做的事

- 不要动超时之后杀进程组那套逻辑
- 不要动 `signal` / abort 那套
- 不要动沙箱包装
- 不要加设置项（那是另一条任务）
- 不要改默认的 120 秒

## 测试要求

往 `apps/studio/src/bun/agent-tools.bash.test.ts` 加用例。照现有第 38 行那条「超时终止整条进程组」的写法搭场景（它已经示范了怎么构造一个会超时的命令）。

至少覆盖这 4 条：

1. **传了 `timeout_ms` 就按它来**：跑一条 `sleep` 足够久的命令、`timeout_ms` 给一个很小的值（比如 300），断言很快就返回、且结果里的超时提示显示的是你传的那个秒数，而不是 120 秒。
   （**这条就是本次要修的缺陷，改之前必须是红的**——现在参数会被直接忽略，命令要跑满 120 秒。注意给用例本身留足够的超时时间。）
2. **超过上限时被夹住**：`timeout_ms` 传 `999_999_999`，断言实际生效的是 600000（可以从超时提示的秒数上看，或者用别的你觉得稳妥的方式；不要为此去导出内部变量）。
3. **非法值退回默认**：`timeout_ms` 传 0 和负数，断言不会因此立刻被杀（也就是没有把非法值当成「超时 0 毫秒」用）。
4. **不传时行为不变**：沿用 `ctx.commandTimeoutMs` 的那条老路仍然有效（现有第 38 行那条用例就是靠它，别让它挂了）。

## 验收标准（汇报第 5 节逐条填）

- [ ] `timeout_ms` 是可选参数，优先级高于 `ctx.commandTimeoutMs`
- [ ] 夹在 `[1000, 600000]` 区间内
- [ ] 非法值（NaN / 0 / 负数 / Infinity）退回默认，不会当成 0 用
- [ ] 工具描述补了说明，原有两句没删
- [ ] 没有动杀进程组 / abort / 沙箱包装 / 默认值
- [ ] 现有 4 条用例一条没删没改，全绿
- [ ] 把 `agent-tools.ts` 的改动还原后，第 1 条用例会变红（你自己先试一遍）
- [ ] 源码改动不超过 25 行

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/19-bash-timeout-param.json
```

输出原样贴进汇报第 4 节。
