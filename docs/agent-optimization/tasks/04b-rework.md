# 任务 04b 返工：你的分析是对的，我给的方案有错。换个插入点

你第 6 节那段分析我独立核实过，**结论成立**：

- `pi-agent-core` 的 `abort()`（dist/agent.js:202-204）是 `this.activeRun?.abortController.abort()`；
- `this.activeRun` 在 `runWithLifecycle` 里才赋值（同文件 :335）；
- 所以 `prompt()` 之前调 `agent.abort()` 确实是 no-op。

我建议的方案 2 错了，你没有硬凑、把源码证据摆出来照实报 FAIL，这是对的处理。

## 换成这个插入点：`makeContextTransform`

你列的方案 A 方向对，但不用改 `getOrCreateSession` 的构造参数，也不用碰第三方库。真正的插入点在**我们自己的代码**里：

`apps/studio/src/bun/agent.ts` 第 1958 行：

```
1958  export function makeContextTransform(
...
1962  ): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
1963    return async (messages, signal) => {
```

这个回调由内核在**每次模型调用之前**执行——同文件第 1144 行的注释就是这么写的：「由 `transformContext` 在**下一次模型调用前**应用」。也就是说它天然位于「run 已经开始、请求还没发出」这个我们要的位置。

信号是只读的，从外面 abort 不了，所以走**抛错**这条路：

在第 1963 行 `return async (messages, signal) => {` 之后的第一件事，加：

```
    // 启动期（或两轮之间）按下的停止：这里是「run 已开始、请求还没发出」的唯一插入点。
    // 内核的 abort() 在 prompt() 之前是 no-op（activeRun 还没建），所以只能从这里抛。
    // 错误文案带 abort：runAgentTurn 的 catch 按 /abort/i 判定，走已有的「已停止」收尾。
    if (stopRequests.has(conversationId)) throw new Error("aborted: stop requested before request");
```

抛出去之后的链路是现成的：内核 `handleRunFailure` → `runAgentTurn` 第 2920 行附近的 catch → `aborted = /abort/i.test(msg)` 为真 → 正文写「已停止」、走正常收尾。**请求一次都不会发出**，这正是用例第 1 条要的。

## 同时删掉那行 no-op

你加的这句请删掉：

```
  if (stopRequests.has(conversationId)) agent.abort();
```

既然已经证明它在这个位置是 no-op，留着就是误导后人的死代码。**第一件事（清除挪到同步段）保留不动**，那个是对的。

## 顺带一个要留意的地方

`makeContextTransform` 有两个调用点：第 1596 行（子智能体）与第 2230 行（主会话）。子智能体传进去的 `conversationId` 是**父会话的 id**，所以这个改动会让「停止父会话」同时拦住子智能体的下一次模型调用。

这是我们想要的（清单里另有一条就是「停止信号传不到子智能体」），**但不要在这条任务里为它加用例或改别处**——如实在汇报第 6 节记一句即可，我另外立条目。

## 用例

第 1 条用例的断言保持原样：**桩服务收到 0 次请求**。现在应该能真的变绿了。

另外补一条：**两轮之间按停止也拦得住**——跑一个会触发重试的场景（桩先返回 500），在退避期间按停止，断言桩收到的请求次数不再增长。如果构造起来不稳，跳过它并在第 6 节说明，不要硬凑。

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/04b-stop-during-startup.json
```

输出原样贴进汇报第 4 节。汇报按六节格式写。
