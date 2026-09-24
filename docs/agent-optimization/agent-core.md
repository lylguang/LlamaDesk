# OmniStudio agent 模块审查 —— 主循环与会话生命周期切片

- 基线：origin/main 24199d4（v0.1.4）只读导出，`scratchpad/agent-baseline`
- 路径均相对 `apps/studio/`；行号为亲自读到的真实行号
- 已读：`src/bun/agent.ts` 全文 3319 行、`agent-retry.ts`、`agent-headless.ts`、`agent-notify.ts`、`agent-outcome.ts`、`agent-goals.ts`、`agent-plans.ts`、`agent-todos.ts`、`agent-interactions.ts`、`src/cli/commands/agent.ts`；为核实机制另读了 `shutdown.ts`、`control-server.ts` 的 agentRun 段、`rpc/index.ts` 的 agent 入口、`automations.ts:380-420`、`db/schema.ts` 的 messages / agent_events、`shared/token-estimate.ts`、`agent-history.ts:40-116`、`agent-tools.ts` 的 bash / task 段、`permissions.ts` 的默认规则段
- 内核契约的核实来源：本机 pnpm store 里的 `@earendil-works/pi-agent-core@0.85.1`（与 package.json 钉的版本一致）的 `dist/agent.js`、`dist/agent-loop.js`。基线导出不带 node_modules，所以这部分引用的是同版本包，而非基线目录内的文件
- 未读、仅据注释引用的文件会在条目里标「未读」

## 0. 依赖与自研边界

| 来源 | 版本 | 提供的能力 |
|---|---|---|
| `@earendil-works/pi-agent-core` | 0.85.1（精确钉版，package.json:32） | `Agent` 类：工具循环、工具执行（**默认并行**，dist/agent.js:134）、steer / followUp 队列、AbortController、`beforeToolCall` / `afterToolCall` / `transformContext` / `shouldStopAfterTurn` 钩子、生命周期事件；失败不抛异常，而是编码成 `stopReason=error\|aborted` 的助手消息 |
| `@earendil-works/pi-ai` | 0.85.1（package.json:33） | provider / model 抽象、openai-completions 流式、传输层重试（`maxRetries`、`retry-after`、抖动）、`isRetryableAssistantError` 错误分类、`clampMaxTokensToContext` |
| `typebox` | 1.3.7 | 工具参数 schema |
| `ai` + `@ai-sdk/openai-compatible` | ^6 / ^2 | **不在 agent 路径上**，只被 chat-model / vllm / music-lyrics / systemone-draft 使用 |

自研部分：会话缓存与重建（`getOrCreateSession`）、回合编排（`runAgentTurn`）、回合级失败重发与空回合提醒（`agent-retry.ts`）、收尾状态判定（`agent-outcome.ts`）、三段式上下文压缩（`makeContextTransform`）、checkpoint / rewind、Goal 续跑与账本、Plan 落盘与批准、授权与提问的挂起 / 唤醒、轨迹落库与推送、子智能体、无头执行与 CLI。根 package.json 没有 agent 相关依赖。

结构概况：`agent.ts` 里 `runAgentTurn` 单函数约 670 行（`:2364-3035`），闭包里有 20 个左右的可变局部量；模块级可变状态 9 处——`sessions`（`:1156`）、`running`（`:1159`）、`stopRequests`（`:670`）、`activeMessageIds`（`:2273`）、`pendingMessages`（`:3097`）和 4 个监听者集合（`:216-219`）外加 `runStateListeners`（`:1173`）；import 时还有副作用（`:262-331` 注册 4 个交互监听）。

## 1. 发现（按收益/成本从高到低）

### F1 同一会话的回合没有重入闸门，启动窗口内的第二次发送会打坏第一轮的运行态
- 类别：可靠性
- 证据：`src/bun/agent.ts:2444`（`await ensureServerReady()`）、`:2489`（`await getOrCreateSession`）、`:2558`（此处才 `setAgentRunning(true)`）、`:2492`（覆盖 `activeMessageIds`）、`:2929-2931`（finally 无条件清运行态）、`:3130`（followUp 只看 `isAgentRunning`）；`src/bun/rpc/index.ts:4187-4196`（`sendAgentMessage` 直接调 `runAgentTurn`，没有占用检查）；内核 `dist/agent.js:226-229`（运行中再 `prompt()` 直接抛错）
- 机制：`running` 要到 2558 行才登记，此前有两段可长达几十秒的 await（等本地推理服务就绪、跑 session_start hook、连 MCP）。这段窗口里 `isAgentRunning` 为 false，第二次发送（用户连点、`followUpAgentMessage`、`approveAgentPlan` 的 `void runAgentTurn`、Goal 续跑与用户消息撞车、自动化与界面同时发）会并行进入第二个 `runAgentTurn`：再插一条 user 和一条空 assistant 行，把 `activeMessageIds` 指到第二条消息，再订阅一次同一个 Agent（`:2589`），并用自己的闭包覆盖正在跑的那一轮的 `agent.shouldStopAfterTurn`（`:2670`，步数计数器换成了第二轮的）。第二轮在真正调 `prompt()` 之前还有两段 await（`:2721` 记忆召回、`:2728` hook），这期间第一轮的工具事件会被第二个订阅者再落库一遍，挂在第二条助手消息下。随后 `agent.prompt()` 因内核已在跑而抛错，第二轮走 catch → finally，把 `running` 置 false，删掉 `activeMessageIds` 与 `stopRequests`，而第一轮还在跑。结果：界面显示已结束（停止按钮消失），第一轮后续的授权 / 提问 / 产出物挂到 `messageId = null`，侧栏运行态错误。
- 附带症状：`:2533` 在两段 await **之后**才 `stopRequests.delete()`，用户在等模型加载期间按的停止会被这行擦掉，回合照常开跑。
- 建议改法：新增模块级 `const starting = new Set<number>()`，在 `runAgentTurn` 第一个 await 之前同步登记。入口处若 `starting.has(id) || running.has(id)`，默认把内容推进 `pendingMessages`（等价 queue）并返回 `{ok:true, queued:true}`，调用方显式要求时返回 `{ok:false, error:"busy"}`。把 `stopRequests.delete()` 挪到入口同步段，并在 `getOrCreateSession` 返回后补一次 `if (stopRequests.has(id))` 早退（走正常收尾，落一条“已停止”）。`isAgentRunning` 改为 `running.has || starting.has`。
- 工时：4h　风险：低（只加闸门，不改回合内部）
- 验收：用桩 LLM（见 F15）写单测。`ensureServerReady` 挂起时并发调两次 `runAgentTurn`，断言只有一条 assistant 行在流式、第二条进了队列、`onAgentRunState` 在第一轮结束前没出现过 false；再测“启动窗口内 stop → 桩服务收不到请求”。

### F2 排队消息被写库两次
- 类别：可靠性
- 证据：`src/bun/agent.ts:3142-3144`（followUp 先落一条 user 消息）、`:3185`（`drainQueuedMessages` 调 `runAgentTurn` 时没传 `insertUserMessage:false`）、`:2465-2474`（默认再插一条）
- 机制：queue 模式的消息在排队那一刻已经落库，排空时又按普通回合再插一遍。运行中的上下文只看到一次（走 prompt），但库里是两条一模一样的 user 行：界面回看多一个气泡；会话一旦重建（换模型、切模式、重新生成），`historyAsAgentMessages` 会把两条都回填给模型。`scripts/agent-live-check.ts:705-709` 的断言用 `.some()`，抓不到重复。
- 建议改法：`drainQueuedMessages` 传 `insertUserMessage: false`；`pendingMessages` 的元素从 `string` 改成 `{ content, messageId }`。顺带处理停止语义：`stopAgentRun` 清队列（`:3212`）时，那几条已落库却永远不会执行的 user 行，要么一并删掉，要么落一条状态事件说明“已取消排队”。
- 工时：1.5h　风险：低
- 验收：单测。运行中 queue 一条，等排空，断言该文本在 `messages` 表里恰好 1 行；stop 后断言队列消息不留无说明的孤儿行。

### F3 停止信号传不到子智能体
- 类别：可靠性 / 安全
- 证据：`src/bun/agent-tools.ts:1231`（`void signal;` 明确丢弃）、`src/bun/agent.ts:1503-1511`（`runSubagent` 入参没有 signal）、`:1677`（`await agent.prompt(...)` 无外部中止途径）、`:1612`（默认最多 12 步）
- 机制：用户按停止，`session.agent.abort()` 只中止父循环的信号。父循环正 await 在 `task` 工具的 Promise 上，子 Agent 是另一个实例，有自己的 AbortController，没人 abort 它。于是 general 型子智能体在“已停止”之后还能继续发最多 12 次模型请求，继续写文件、跑命令；父回合要等它跑完才返回，界面上就是停止没反应。子智能体里新发起的授权请求拿的是子 Agent 自己的 signal，也不会因父级停止而收尾。
- 建议改法：`ToolContext.spawnSubagent` 入参加 `signal?: AbortSignal`，task 工具把自己的 signal 传下去；`runSubagent` 里 `signal.addEventListener("abort", () => agent.abort(), { once: true })`，进入前若已 aborted 直接返回；finally 里摘监听。
- 工时：2h　风险：低
- 验收：桩 LLM 让子智能体每步 sleep。父级 stop 后断言 1 秒内 `subagent_end` 落库，此后没有新的带 `subagentId` 的 `tool_start`，桩服务不再收到请求。

### F4 失败的回合对调用方仍然返回 ok:true，CLI 退出码与自动化状态因此失真
- 类别：可靠性
- 证据：`src/bun/agent.ts:2855-2871`（error 收尾只改 `fullText`）、`:2914-2922`（catch 同样只改正文）、`:2977`（`emitDone` 不带 `error`）、`:3033-3034`（只有 hook 拦截才返回 `ok:false`）；`src/bun/agent-headless.ts:135`、`:151`（`ok: !error`，而 error 只来自这两个来源）；`src/bun/automations.ts:397`、`:411`（据 `result.ok` 记 succeeded / failed）；`src/cli/commands/agent.ts:129`、`:142`（据 ok 决定退出码）
- 机制：模型请求失败、流中断、重试耗尽、被中止、空回合，这些在 `runAgentTurn` 内部都已经被 `classifyTurnOutcome` 判出来了，但结果只写进正文（`⚠️ …`），返回值恒为 `{ok:true}`。于是 `omi agent run` 在推理服务挂掉时以退出码 0 结束，自动化运行记录写成 succeeded。对一个定位为 CI 入口的命令，这是实质缺陷。
- 建议改法：`runAgentTurn` 返回值扩成 `{ ok, error?, outcome: "ok" | "error" | "aborted" | "empty" | "blocked" | "step_limit" }`，error / catch 分支记下 `turnError`；`DoneListener` 负载加 `outcome` 字段（不要复用 `error`，界面对 `error` 的渲染路径未读，复用有连带风险）。`runHeadlessAgent` 的 `ok` 取 `outcome === "ok" || outcome === "step_limit"`。
- 工时：2h　风险：低到中（RPC 返回类型变更，需同步 `rpc` 类型声明）
- 验收：单测。桩 LLM 恒返回 500，断言 `runAgentTurn` 返回 `ok:false, outcome:"error"`，`runHeadlessAgent().ok === false`；CLI 集成断言退出码为 1。

### F5 无人值守回合遇到 ask 类授权会干等 10 分钟，与文档声明相反；CLI 断开停不了运行；Goal 模式只等第一轮
- 类别：可靠性 / 体验
- 证据：`src/bun/agent.ts:2225-2257`（`beforeToolCall` 没有 headless 分支，尽管 `session.headless` 就在闭包里）、`src/bun/agent-interactions.ts:59`（默认 10 分钟）与 `:195-201`；`src/bun/agent-headless.ts:15-16`（注释声称无头回合“直接以拒绝理由回到模型”）；`src/bun/permissions.ts:246`（`doom_loop` 在所有审批档位下都是 ask，含 auto）；`src/cli/commands/agent.ts:103`（CLI 默认超时同为 600000ms）；`src/bun/control-server.ts:423-460`（ReadableStream 只有 `start` 没有 `cancel`，`:429` 注释承认客户端断开后照常跑完）；`src/bun/agent.ts:3028-3031`（续跑是 `void`，不被等待）与 `src/bun/agent-headless.ts:128-148`
- 机制：
  1. headless 只处理了 `ask_user` 与沙箱升级，普通授权没处理。smart 档位下的危险命令、工作区外访问，以及任何档位下的原地打转检测，都会在自动化 / `omi agent run` 里挂到 10 分钟超时才按拒绝处理，恰好等于 CLI 默认超时，表现为 CLI 超时退出而后台回合还在跑。
  2. CLI 被 Ctrl-C 或超时后，服务端没有取消路径，回合带着副作用继续执行。
  3. `--mode goal` 或自动化的 goal 模式：`runAgentTurn` 在第一轮结束就返回，续跑在后台进行。NDJSON 流已关闭，自动化摘要取的是第一轮正文，`runningAutomations.delete(id)` 也已执行，同一个自动化可能被再次触发而与自己的续跑并行。
- 建议改法：`authorizeToolCall` 增加 `unattended?: boolean`，为真时 ask 直接返回拒绝文案（“无人值守运行，无法询问用户；请换一种不需要该授权的做法”），`beforeToolCall` 传 `session.headless`。若产品上希望桌面开着时仍可点卡片，加设置项 `AGENT_HEADLESS_ASK = deny | wait`，默认 deny。`streamAgentRun` 的 ReadableStream 补 `cancel()` 调 `Agent.stopAgentRun(conversationId)`，非流式分支监听 `req.signal`。`runAgentTurn` 增加 `awaitContinuations?: boolean`，headless 调用方置 true 时 `await maybeContinueGoal(...)` / `await drainQueuedMessages(...)` 而不是 `void`。
- 工时：4h　风险：低（行为变更需写进 CHANGELOG）
- 验收：单测。headless 回合调用一条命中 ask 规则的 bash，断言 100ms 内返回拒绝文案且没有 `permission_request` 事件；集成：`omi agent run --json` 中途 kill CLI，断言 2 秒内 `getAgentRunState().running === false`；goal 模式下 `runHeadlessAgent` 在目标终结或刹车后才 resolve。

### F6 助手消息行建出来之后、try 之前抛异常，界面永远停在“处理中”
- 类别：可靠性
- 证据：`src/bun/agent.ts:2487`（`insertAssistantMessage` 同时向 UI 推 started，见 `src/bun/chat.ts:173-181`）、`:2489`（`getOrCreateSession` 可抛：hook 执行、`buildMcpAgentTools`、`historyAsAgentMessages` 读库）、`:2668`（try 从这里才开始）、`:2977`（`emitDone` 只在正常路径上）
- 机制：2487–2668 之间的异常会绕过 finally 与 `emitDone`。RPC 以 rejected 返回，库里留下一条空 assistant 行，UI 收到过 started 却永远等不到 done。入口早退分支（`:2390` 的注释）已经写明漏一条 done 就是“发了没反应”，这一段是同一问题的漏网之处。
- 建议改法：把 try 提前到 `insertAssistantMessage` 之后立刻开始；`session` 改成 `let session: Session | null`，收尾处的 `contextUsage` 用可选值。抽一个 `failTurn(assistantId, message)`：写库 `⚠️ message`、记 error 事件、`emitDone`。
- 工时：2h　风险：低
- 验收：单测。mock `runHooks` 抛错，断言收到 `onAgentDone`，助手行正文为 `⚠️ …`，`running` 未残留。

### F7 token 估算不计 toolCall 参数，写文件类回合的上下文被系统性低估
- 类别：可靠性 / 性能
- 证据：`src/shared/token-estimate.ts:57-69`（只取 `part.text`，toolCall 计为字面量 `[toolCall]`）；使用点 `src/bun/agent.ts:2002`、`:2004`，`src/bun/agent-compaction.ts:51`、`:62`、`:84`、`:168`、`:174`
- 机制：编码 agent 的助手输出大头是 `write_file.content`、`apply_patch.patch` 这类工具参数，动辄几千到几万字符，估算里各只值约 3 token。压缩预算（窗口 60%）因此迟迟不触发，真实请求却已顶满窗口；pi-ai 的 `clampMaxTokensToContext` 随后把 `max_tokens` 钳到下限，表现正是代码里已经专门写了诊断文案的“长度钳制型空回合”（`src/bun/agent-retry.ts:73-86`）。现有诊断把它归因于窗口配置太小，这条是另一个成因。
- 建议改法：`textOf` 对 `type === "toolCall"` 的块追加 `JSON.stringify(part.arguments ?? {})`，对 `type === "thinking"` 取 `part.thinking`，图片块按固定值（如 1000）计。同步核对 `contextUsage` 的估算口径。
- 工时：1.5h　风险：低（压缩会更早触发，这是期望行为；需回归 `agent-compaction*.test.ts`）
- 验收：单测。一条带 40KB `write_file` 参数的助手消息估算 ≥ 10000；同样的历史在 8k 窗口的压缩流水线测试里会触发裁剪。

### F8 Goal 续跑与排队消息不带 mode / headless，全局模式一变就改了别的会话的下一轮
- 类别：可靠性
- 证据：`src/bun/agent.ts:3082-3088`（续跑的 `runAgentTurn` 没传 `mode`）、`:3185`（排空时没传 `mode`，也没传 `headless`）、`:2459`（缺省取全局设置 `getAgentMode()`）、`:3055`（`maybeContinueGoal` 第一行就要求 `mode === "goal"`）、`:2127-2136`（任何键不一致都记一条“模型已切换”）
- 机制：`AGENT_MODE` 是全局设置，会话却是并行的。自动化或 CLI 以 `mode:"goal"` 起的回合，第一次续跑就按全局模式（多半是 agent）跑：`getOrCreateSession` 发现 mode 不一致，整个会话重建（丢摘要记账，从库里重灌历史）；这一轮结束时 `maybeContinueGoal` 拿到 mode=agent 直接返回。净效果是 headless 的 Goal 模式续跑一次就静默停了。交互场景同理：用户在会话 B 切了模式，会话 A 排队中的下一轮跟着变。headless 起的回合，排队的后续轮次也丢了 headless，会重新弹 ask_user。另外 `:2133` 的轨迹文案无论实际变的是模式、工作区还是 headless，都写“模型已切换”。
- 建议改法：`maybeContinueGoal` 调用处补 `mode: opts.mode`；`drainQueuedMessages(conversationId, workspace, mode, headless)` 全量透传。`getOrCreateSession` 里比对出具体变化项再写轨迹。进一步（可选，+3h）：只有 mode 变化时不重建会话，改为热替换 `agent.state.tools` 与 `systemPrompt`（内核支持赋值，dist/agent.js:153），保留 transcript 与摘要记账；批准方案（`src/bun/rpc/index.ts:4286-4304`）必然触发一次 plan → agent 切换，收益最直接。
- 工时：2h（含可选项 5h）　风险：低
- 验收：单测。全局模式为 agent 时以 `mode:"goal"` 起 headless 回合，断言续跑轮的 session.mode 仍为 goal 且续跑次数 > 1；排队轮沿用 headless。

### F9 应用退出不收尾 agent：脱离进程组的 bash 成为孤儿，跑了一半的正文整段丢失
- 类别：可靠性
- 证据：`src/bun/shutdown.ts:34-65`、`:68-74`（收尾清单里没有 agent）；`src/bun/agent-tools.ts:802-809`（bash 以 `detached: true` 起独立进程组）；`src/bun/agent.ts:2934-2937`（助手正文只在回合结束时写库）、`:1727`（回填历史时过滤掉空正文的行）
- 机制：`shutdown.ts` 的头注释专门讲了 detached 推理服务活过升级的事故，agent 的 bash 是同一类进程，却不在收尾清单里：退出或升级时正在跑的命令（测试、构建、dev server）会留下来。另一面，一个回合可以跑 40 步、几十分钟，期间 `messages.content` 一直是空串。进程被杀或崩溃后，这条助手行永远为空，重建会话时被 1727 行过滤掉，模型和用户都看不到这一轮说过什么。`text` 事件逐步落了库，但没有代码用它恢复正文。
- 建议改法：
  1. `agent.ts` 导出 `abortAllAgentRuns()`：遍历 `running` 逐个 `stopAgentRun`。`teardownServices` 在停推理服务**之前**调用，并最多等 2 秒（`agent.waitForIdle()`，dist/agent.js:210）；`teardownServicesSync` 调同步版（只 abort 不等）。
  2. 在 `turn_end` 分支（`:2607-2633`）里把 `committedText` / `committedReasoning` 写回 `messages`（每步一次 UPDATE，不是每 token）。
  3. 启动时扫一遍 `role='assistant' AND content=''` 的行：用该 messageId 下的 `text` 事件拼回正文，末尾追加“_（上次运行被中断）_”。
- 工时：6h　风险：中（退出路径不能拖慢关窗；第 2 项只写 committed 部分，才能与重试时的正文回退 `:2798-2799` 保持一致）
- 验收：集成脚本。回合跑到第 3 步时对主进程 `kill -TERM`，断言无残留 bash 进程组；重启后该助手消息正文非空且带中断标记。

### F10 会话内存只增不减，且每一步都对全量历史做约 5 遍逐字符扫描
- 类别：性能 / 内存
- 证据：`src/bun/agent.ts:1156`（`sessions` Map，只有 `resetAgentSession` `:1197` 会删）、`:1975-2079`（`transformContext` 只改本次请求的副本）、`:1023`（只有手动 `/compact` 才真正替换 `state.messages`）、`:394-415`（删除会话时不删 `sessions` / `pendingMessages` / `activeMessageIds`）；`src/bun/rpc/index.ts:4072-4076`（删除会话不 stop、不 reset，对比 `:4253` 归档会 stop）；`src/shared/token-estimate.ts:15-35`（逐码点循环）
- 机制：
  - 自动压缩从不回写 `agent.state.messages`，长会话的 transcript 无限增长（每条工具结果最多 24000 字符，`view_image` 还带 base64）。每次模型请求前，`pruneSupersededReads` 估两遍，摘要判断估一遍，`compactMessages` 再估两遍以上，全部是对**全量**历史的逐码点循环，跑在 Bun 主线程上，同一线程还要服务 RPC 和其它会话的流式推送。单步成本随会话长度线性增长，整场会话 O(n²)。量级未证实：按 300 条消息 × 平均 8KB 估，每步约 10–15MB 字符扫描。
  - 进程生命周期内跑过的每个会话都常驻一个 Agent 实例，删除会话也不释放。正在运行的会话被删除后会继续跑，往已删除的会话里写孤儿事件；`agent_goals` / `agent_plans` 行与方案文件同样留下（`src/bun/chat.ts:334-339` 只删 messages / conversations）。
- 建议改法：
  1. 估算结果按消息对象缓存：`const tokenCache = new WeakMap<object, number>()`，`estimateMessagesTokens` 先查缓存（消息入列后不再变更；`pruneSupersededReads` 的替换件是新对象，天然失效）。
  2. 回合结束后做一次物理折叠：若 `session.summary` 存在，`state.messages = state.messages.slice(coveredCount)`，`summary.coveredCount = 0`。`makeContextTransform` 在 `:2001` / `:2044` 已按“摘要 + 余下消息”拼装，折叠后发给模型的内容不变。有未收网的 checkpoint 时同步平移 `atMessageCount`，或本轮跳过折叠。
  3. `deleteConversationEvents` 里补 `stopAgentRun` + `resetAgentSession` + `clearQueuedMessages` + `clearGoal` + `clearPlan`；`sessions` 加空闲淘汰（非运行且 30 分钟未用即删，重建路径 `historyAsAgentMessages` 已存在）。
- 工时：6h　风险：中（折叠与 checkpoint / rewind 的下标交互要单测钉住）
- 验收：基准脚本。构造 400 条消息的会话，记录 `transformContext` 单次耗时，改后下降一个数量级且不随轮次增长；删除运行中会话后 `running === false`，`agent_events` 无新增行。

### F11 轨迹不存 toolCallId，并行工具的调用与结果按“后进先出”猜配对
- 类别：可靠性
- 证据：`src/bun/agent.ts:2634-2657`（`tool_start` / `tool_end` 落库时都丢弃了事件里的 `toolCallId`）、`:1630-1652`（子智能体同样）；`src/bun/db/schema.ts:120-141`（表上没有该列）；`src/bun/agent-history.ts:62-100`（注释承认“结果顺序不保证”，按同名 LIFO 配对）；内核默认并行执行（dist/agent.js:134，dist/agent-loop.js:330-375：先依次发出全部 start，再 `Promise.all` 执行，end 按完成顺序到达）
- 机制：一条助手消息里并行两次 `read_file(A)`、`read_file(B)` 时，事件顺序是 startA、startB、endA、endB（A 先开始通常也先结束）。LIFO 会把 endA 配给 B。会话重建（换模型、切模式、重新生成之后）回填给模型的就是“读 B 得到 A 的内容”，时间线上的卡片也错位（`mainview/app/agent/timeline-model.ts` 据注释用同一规则，未读）。同名并行调用在探索类任务里很常见。
- 建议改法：迁移加列 `tool_call_id text`；`recordEvent` 增加 `toolCallId` 入参，四处落库点传 `event.toolCallId`；`pairToolEvents` 优先按 id 配对，旧数据（列为空）回落到现有规则并改为 FIFO；时间线模型同步。
- 工时：5h　风险：低到中（含一次 DB 迁移）
- 验收：`agent-history.test.ts` 新增用例。startA、startB、endA、endB 带 id 时 A↔A、B↔B；不带 id 的旧行不抛错。

### F12 tool_start 的入参原样整份落库并推给界面，打开会话时一次性全量加载
- 类别：性能
- 证据：`src/bun/agent.ts:2638-2645`（`args: event.args`）、`:365`（`JSON.stringify(row.args)` 无上限）、`:371`（整行推给 webview）、`:384-391`（`select *`）；`src/mainview/app/agent/conversation.tsx:52-55`（打开会话不带 afterId 取整份）；`src/bun/agent.ts:1731`（每次重建会话也整份读，而回填只用 tool_start / tool_end，且结果截到 2000 字符，见 `src/bun/agent-history.ts:22`、`:75-77`）
- 机制：工具**输出**有 24000 字符上限（`afterToolCall` 统一截断），**入参**没有。`write_file` 的整份文件内容、`apply_patch` 的整份补丁都会原样进 `agent_events.args`，再经 RPC 推给界面。长会话打开时把所有事件的 args + output 全部读出、序列化、传给 webview；重建会话时再来一遍，连用不到的 status / text / 子智能体事件一起读。
- 建议改法：
  1. `recordEvent` 对 args 做逐字段截断：字符串值超过 4000 字符的保留头部并附 `…（共 N 字符）`，完整内容本来就在工作区文件或回合快照里。
  2. `listAgentEvents` 增加 `opts.forHistory`：只取 `kind in ('tool_start','tool_end') and subagent_id is null`，`output` 用 `substr(output,1,2001)`。
  3. 界面首屏只取最近 N 条消息的事件（按 `message_id` 窗口），上滚再取。
- 工时：5h　风险：低到中（第 1 项改变回填给模型的历史入参，方向是减负）
- 验收：写一个 200KB 文件后断言对应 `agent_events.args` 长度 < 10KB；500 事件会话的首屏 RPC 负载从 MB 级降到百 KB 级。

### F13 几处小额读写放大与缺事务的多语句写
- 类别：性能 / 可靠性
- 证据与机制：
  - `src/bun/agent.ts:1266-1275`：侧栏每 4 秒轮询（`src/mainview/app/agent/session-sidebar.tsx:469`），预览查询把每个会话最后一条消息的**全文**取回再在 JS 里截 160 字符。
  - `src/bun/agent.ts:1301`、`:1312`：循环内逐行调 `getAgentWorkspace()`（含 `existsSync`）与两次 `listPending*`（各自对全部挂起项排序）。
  - `src/bun/agent.ts:2476`：为判断“是不是第一条消息”读出整个会话的全部消息正文。
  - `src/bun/agent.ts:2934-2937` 与 `:2961-2969`：回合收尾对同一行连续两次 UPDATE，第一条完全被第二条覆盖。
  - `src/bun/agent.ts:3255-3260`、`:3301-3304`：重新生成 / 回退时逐条消息各发一次 `DELETE ... WHERE message_id = ?`，`agent_events` 上没有 message_id 索引（`src/bun/db/schema.ts:138-141` 只有 conversation_id），每次都是全表扫描，且整段删除不在事务里，中途崩溃会留下删了一半的会话。
  - `src/bun/agent-todos.ts:71-82`：先 DELETE 再逐条 INSERT，无事务，每条各自提交。
- 建议改法：预览改 `substr(m.content, 1, 400)`；循环外取一次 `fallbackWorkspace`，并把挂起项先聚合成 `Set<conversationId>`；2476 改 `select count(*)`；删掉 2934 的第一次 UPDATE；删除改成 `db.transaction` 内一条 `DELETE FROM agent_events WHERE conversation_id = ? AND message_id IN (...)`（能用上现有索引，不需要迁移）；`writeTodos` 包进 `db.transaction` 并用一次多行 insert。
- 工时：3h　风险：低
- 验收：现有 `agent-history` / `agent-events` 测试全绿；新增用例断言回退是原子的（事务内抛错后消息与事件都还在）；200 个会话下 `listAgentSessions` 单次耗时下降并写进基准。

### F14 交互收尾的两处缺口：提问超时不发 settled；停止 / 重置会取消别的会话的生图确认
- 类别：体验 / 可靠性
- 证据：`src/bun/agent-interactions.ts:292`（提问超时只 `finish([])`，对比授权超时 `:197-200` 会先 `emitSettled`）；`src/bun/agent.ts:1202`、`:3208` 调用的 `cancelMediaSetup()` 不带会话参数（`src/bun/media-setup.ts:93-95` 取消**全部**挂起项）
- 机制：ask_user 挂满 10 分钟后，工具拿到空答案继续跑，但界面收不到 `questionSettled`，卡片一直挂着；轨迹里只有 `question_request` 没有配对的 `question`，回看历史时这张卡片永远显示为未答。多会话并行时，对会话 A 按停止或切工作区，会把会话 B 正在等用户确认的生图弹窗一起取消。
- 建议改法：292 行的定时器回调改成先 `emitQuestionSettled({ conversationId, id, answers: [] })` 再 `finish([])`；`cancelMediaSetup(conversationId?: number)` 按会话过滤（挂起项需记录 conversationId），agent.ts 两处传入会话 id。
- 工时：1.5h　风险：低
- 验收：单测。`askQuestions({ timeoutMs: 10 })` 超时后收到 settled 事件；两个会话各挂一个生图确认，停止 A 后 B 的 Promise 仍未决。

### F15 回合编排没有任何单元测试，桩 LLM 只存在于 smoke 脚本里
- 类别：测试 / 可维护性
- 证据：`src/bun/agent.ts:2364-3035`（`runAgentTurn` 约 670 行单函数）、`:216-219`、`:670`、`:1156-1159`、`:2273`、`:3097`（模块级可变状态）、`:262-331`（import 即注册监听的副作用）；测试侧只有 `agent-events.test.ts`（2 例，测 `listAgentEvents`）和 `agent-compaction-pipeline.test.ts`（3 例，测 `makeContextTransform`）引用了 `./agent`；`agent-interactions.ts`、`agent-todos.ts` 没有对应测试文件；`agent-headless.test.ts` 只有 2 例入参校验；脚本化桩服务在 `scripts/agent-resilience-smoke.ts:207` 与 `scripts/agent-live-check.ts:357` 各写了一份
- 机制：`runAgentTurn`、`followUpAgentMessage`、`drainQueuedMessages`、`stopAgentRun`、`maybeContinueGoal`、`runSubagent`、`regenerateAgentMessage`、`revertAgentSession` 都没有 `bun test` 级别的覆盖，F1–F6、F8 这类并发与收尾缺陷只能靠 smoke 脚本的 `.some()` 式断言碰运气。模块级状态让测试之间互相污染，也没法在一个进程里起两套运行时。
- 建议改法（分三个可独立合并的 PR）：
  1. 把两份桩服务合并抽到 `src/bun/testing/stub-llm.ts`（脚本化 SSE：按序返回文本、工具调用、500、半截流、空消息），两个 smoke 脚本改为引用它。
  2. 新增 `agent.turn.test.ts`，先覆盖 F1 / F2 / F3 / F4 / F6 的验收用例。
  3. 拆 `runAgentTurn`：`validateTurn()`（`:2388-2457` 的早退）、`TurnRecorder` 类（`:2519-2587` 的累计状态 + `:2589-2666` 的事件处理，纯内存，可单测“失败回合正文回退”）、`finalizeTurn()`（`:2934-3031`）。把 5 个模块级集合收进 `class AgentRuntime`，默认导出一个单例保持现有 API，测试里可 new 新实例。
- 工时：PR1 3h、PR2 5h、PR3 8h，合计 16h　风险：PR1 / PR2 低，PR3 中（纯搬移，靠 PR2 的测试兜底）
- 验收：`bun test` 新增用例 ≥ 12 条且全绿；`runAgentTurn` 主体降到 150 行以内；smoke 脚本行为不变。

## 2. 看起来像问题、但代码已经处理好的点

1. **流式增量没有逐 token 推 IPC。** `src/bun/agent.ts:2564-2569` 用与对话页同一份 `createChunkFlusher`，40ms 合并一批（`src/bun/chunk-flusher.ts:13`）；失败重发前 `flusher.discard()`（`:2794`）丢掉未发的半截；收尾先 `flushNow` 再 `emitDone`（`:2927-2928`）。逐 token 回调只留给通话 TTS（`:2603`）。
2. **事件持久化不是逐 token 写库，读取也有增量路径。** 正文按“步”聚合，在工具开始前冲成一条 `text` 事件（`:2579-2587`、`:2637`），工具 start / end 各一条，量级是每步几条。`listAgentEvents(afterId)`（`:384-391`）配合 conversation_id 索引是范围扫描（SQLite 二级索引隐含 rowid，`id > ?` 可下推）；界面跑动中每 4 秒按 afterId 追平（`src/mainview/app/agent/conversation.tsx:211-229`），正常返回空数组。大工具输出在 `afterToolCall` 统一截断转存（`:642-661`），落库的是截断后的文本。
3. **回合级重试不会重放有副作用的工具。** 只在 `stopReason=error` 且 pi-ai 判定可恢复时重试（`src/bun/agent-retry.ts:47-51`，配额 / 计费类被排除，被中断的永不重试）；重发前只摘末尾连续的失败空壳（`:107-116`），再用 `agent.continue()` 接着发，已成功的工具结果留在上下文里（`src/bun/agent.ts:2781-2822`）。退避期间按停止有 `stopRequests` 兜住（`:670-679`、`:2819-2821`）。内核契约由 `agent-retry.loop.test.ts:168-192` 钉住。
4. **授权等待不泄漏定时器与监听。** `finish` 里清 timer、摘 abort 监听、删两个 Map（`src/bun/agent-interactions.ts:186-194`），已中止的 signal 补触发一次（`:202-204`）。
5. **系统提示保持字节稳定以保住前缀缓存。** 时间提醒挂在本轮用户消息上（`src/bun/agent.ts:691-694`），系统提示只在内容真变了才回写（`:2714-2719`），Goal 段落只在目标存在时注入（`:797`）。

## 3. 其它观察（未列入排序，供取舍）

- 重试预算相乘：传输层 `maxRetries`（`src/bun/agent.ts:614`）与回合层重发（`:2784`）共用同一个 `AGENT_RETRY_MAX`，一步失败最坏发 (N+1)² 次请求，N=5 时 36 次，每次传输层退避上限 30 秒。可考虑传输层固定封顶 2。
- Goal 的 token 预算只在回合结束时核对（`:3005-3021`），单个回合 40 步内可以大幅超支；可在 `shouldStopAfterTurn` 里加一道。
- 入口早退分支用 `messageId: Date.now()` 发 done（`:2398` 等），界面无法与任何消息行对应。
- `getHistory` 按 `createdAt` 排序（`src/bun/chat.ts:466-474`），user 行与 assistant 行可能同毫秒插入；稳定性依赖 SQLite 排序实现，未证实会出错，建议加 `id` 作次序键。
