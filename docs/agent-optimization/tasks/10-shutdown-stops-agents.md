# 任务 10：应用退出不收尾 agent，留下孤儿进程

工作树根目录：`/home/xixi/Git/OmniStudio/.claude/worktrees/agent-optimize`

## 允许改动的文件（只有这三个）

1. `apps/studio/src/bun/agent.ts` —— 只许**新增**一个导出函数，别的一处不许改
2. `apps/studio/src/bun/shutdown.ts` —— 只许在两个收尾函数里各加一处调用与一行 import
3. `apps/studio/src/bun/agent-shutdown.test.ts` —— 你要新建的测试文件

别的文件一个都不许碰。

## 现状

`apps/studio/src/bun/shutdown.ts` 全文 74 行，收尾链里有推理服务、语音、OCR、网关、隧道、侧栏终端、技能、控制服务——**没有任何一项与 agent 有关**。

而 agent 的 `bash` 工具是以**独立进程组**启动的（`apps/studio/src/bun/agent-tools.ts` 里 `detached: true`，注释说明是为了超时时能整组杀掉）。

`agent.ts` 里已经有两个现成的运行态集合（第 1161 行附近）：

```
const running = new Set<number>();
const starting = new Set<number>();
```

以及一个现成的停止入口（第 3246 行附近）：`export function stopAgentRun(conversationId: number)`，它会 `stopRequests.add`、取消挂起的授权与提问、清排队消息、调 `session.agent.abort()`。

## 缺陷

用户关掉应用（或应用升级重启）时，如果还有 agent 回合在跑：

- 正在跑的 `bash` 是独立进程组，父进程退出后它**变成孤儿继续跑**（`seq`、`npm install`、测试套件都可能跑很久）；
- 回合的正文只在收尾时才落库（`agent.ts` 的 `finally` 里那次 `db.update`），进程直接退出等于**这一轮已经生成的正文整段丢失**；
- 挂起的授权弹窗、排队消息也都没收。

## 期望语义

**一、`agent.ts` 新增一个导出函数**，放在 `stopAgentRun` 附近：

```
/**
 * 应用退出时收尾所有在跑的 agent 回合。
 *
 * 只做「请求停止」这一件事：具体的中止、正文落库、进程组回收都由各自回合的
 * 收尾路径完成（`stopAgentRun` → abort → finally）。这里不重复实现，也不等它们跑完
 * —— 退出路径上不能被某个卡住的回合拖住。
 *
 * 返回被请求停止的会话数，给日志用。
 */
export function stopAllAgentRuns(): number {
  ...
}
```

实现要点：

- 把 `running` 与 `starting` 两个集合里的会话 id 合起来去重（启动中的也要停——那段窗口里 `bash` 还没起，但授权弹窗和会话可能已经建了）；
- 对每个 id 调现成的 `stopAgentRun(id)`，**包在 try/catch 里**，一个失败不影响其余（收尾阶段最怕「一个失败把其余都跳过」，`shutdown.ts` 第 31 行的注释就是这个意思）；
- 返回处理过的会话数；
- **不要 await 任何东西**，这个函数必须是同步的（同步版收尾路径也要用它）。

**二、`shutdown.ts` 两处都加上**：

- `teardownServices()` 里，放在 `closeAllTerminals()` 那一组旁边（第 59 到 62 行附近）。侧栏终端已经在那里收了，agent 回合是同一类东西。
- `teardownServicesSync()` 里（第 68 到 74 行）同样加一句。

import 从 `./agent` 取。把返回的会话数写进一条日志或注释说明都可以，但**不要**为此引入新的日志依赖——那个文件现在是按需 `import("./app-log")` 的，别把它改成顶层 import。

## 不要做的事

- 不要改 `stopAgentRun` 本身
- 不要改 `agent-tools.ts` 的 `detached` 或杀进程逻辑
- 不要在 `shutdown.ts` 里 await agent 相关的东西（退出路径不能被拖住）
- 不要动 `shutdown.ts` 里现有的任何一项收尾

## 测试要求

新建 `apps/studio/src/bun/agent-shutdown.test.ts`。照 `agent-turn.test.ts` 的写法搭架子（起桩、`updateSettings`、建会话）。

至少覆盖这 3 条：

1. **有回合在跑时，`stopAllAgentRuns()` 返回被停的会话数、且之后运行态回落**：起一个会卡住的回合（桩服务先不返回），调 `stopAllAgentRuns()`，断言返回值 ≥ 1，等回合结束后 `Agent.isAgentRunning(id)` 为 false。
2. **没有回合在跑时返回 0 且不抛错**（退出路径上最常见的情形）。
3. **多个会话同时在跑时都会被停**：起两个会话各一个卡住的回合，断言返回值为 2、两个的运行态都回落。

**注意**：这个函数必须是同步的，用例里直接调、不要 await 它。

## 验收标准（汇报第 5 节逐条填）

- [ ] `stopAllAgentRuns` 是同步函数，不 await 任何东西
- [ ] `running` 与 `starting` 都纳入，且去重
- [ ] 每个会话的停止包了 try/catch，一个失败不影响其余
- [ ] `shutdown.ts` 的异步版与同步版都加上了
- [ ] 没有 await agent 相关的东西
- [ ] `shutdown.ts` 现有收尾项一项没动，也没把 `app-log` 改成顶层 import
- [ ] 把两个源码文件的改动还原后，第 1 条用例会变红（你自己先试一遍）
- [ ] 源码改动（两个文件合计）不超过 35 行

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/10-shutdown-stops-agents.json
```

输出原样贴进汇报第 4 节。
