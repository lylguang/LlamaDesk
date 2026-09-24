# OmniStudio agent 模块审查：界面层 / 事件传输 / RPC 接线 / 数据库

- 基线：origin/main 24199d4（v0.1.4）只读导出，未做任何修改。所有路径相对 `apps/studio/`，行号均为本次亲自读到的行号。
- 方法：精读 `src/mainview/app/agent/` 下 timeline / timeline-model / message / conversation / composer / session-sidebar / index / terminal-tab / browser-tab / review-tab / right-panel（片段）；顺 import 读完 `stores/agent.ts`、`stores/chat.ts`、`stores/terminal.ts`、`lib/rpc.ts`、`components/markdown.tsx`、`hooks/use-server-message-sync.ts`、`hooks/use-view-state-report.ts`；bun 侧读了 `chunk-flusher.ts`、`terminal-sessions.ts`、`agent.ts` 的事件 / 会话列表 / 搜索 / 回合收尾段、`chat.ts` 的会话加载段、`rpc/index.ts` 的 agent handler 段与推送接线段、`db/schema.ts` 与迁移 0010 / 0021 / 0026 / 0030。
- 「未证实」= 依赖第三方库内部行为或运行时实测，本基线（无 node_modules、未运行）无法验证。
- 排序：按「收益 / 成本」从高到低。

---

## 发现一览

| # | 标题 | 类别 | 工时 |
|---|------|------|------|
| 1 | 输入区订阅了整份 activeMessages，每个流式增量重渲染整个 Composer | 性能 | 0.5h |
| 2 | Agent 页流式正文没传 `mode="streaming"`（对话页传了） | 性能 / 体验 | 0.5h |
| 3 | 打开会话时轨迹事件被全量加载两次 | 性能 | 1h |
| 4 | 三处界面入口失效：运行中「排队发送」按钮、用户消息「回到这条提问」、侧栏「归档」分组 | 可靠性 / 体验 | 2.5h |
| 5 | 自动滚动无条件贴底，流式时无法上翻回看 | 体验 | 2h |
| 6 | 消息列表无 memo：每个增量 / 事件重渲染全部消息 | 性能 | 5h |
| 7 | 时间线 key 带 index + 子智能体分组恒排末尾，展开状态会被新事件冲掉 | 体验 | 2h |
| 8 | 右侧面板：浏览器页签每次导航新增一个页签；终端重挂载回放重复；PTY 无回收 | 可靠性 | 4h |
| 9 | 会话搜索：跨应用泄漏、逐命中 N+1、先查后截断、前端无防抖 | 可靠性 / 性能 | 3h |
| 10 | 空闲时约每秒 1 次轮询；会话列表每 4 秒读出每个会话末条消息全文 | 性能 | 4h |
| 11 | 运行中重进会话，流式尾巴错位或不可见（正文只在回合末落库） | 可靠性 | 7h |
| 12 | 历史加载：消息与事件一次性全量、无列裁剪，且窗口回焦即全量重取 | 性能 | 8h |
| 13 | rpc/index.ts 的 agent 段（66 个 handler）可抽成独立文件 | 可维护性 | 8h |
| 14 | 大组件职责拆分（message / session-sidebar / composer / composer-controls / timeline） | 可维护性 | 8h |
| 15 | 测试与冒烟盲区 | 测试 | 8h |

---

## 1. 输入区订阅了整份 activeMessages，每个流式增量重渲染整个 Composer

- 类别：性能
- 证据：`src/mainview/app/agent/composer.tsx:286`（订阅）、`:493-496`（唯一用处）；`src/mainview/stores/chat.ts:264-283`（每个 chunk 新建数组）
- 机制：`AgentComposer` 用 `useChatStore((s) => s.activeMessages)` 订阅消息数组，但它只在 `handleSend` 里拼乐观用户消息时用一次。bun 侧 40ms 一批推 chunk，`appendChunk` 每批新建 `activeMessages` 数组，于是 789 行的 Composer 连同 `WorkspacePicker`、5 个面板、`ComposerSuggestions`、`ContextInspector`、`ModelThinkingPicker` 每秒重渲染约 25 次。`useComposerSuggestions` 里的三个正则结果每次是新数组（`composer-suggestions.tsx:73-76`），`useMemo` 依赖因此每次失效，@ 补全打开时每次还要过滤整份文件列表。
- 改法：删掉 `:286` 的订阅，`handleSend` 内改为 `useChatStore.getState().activeMessages`。顺手把 `composer-controls.tsx:477` 的 `s.messageStats` 整表订阅改成只取最后一条的选择器。
- 工时：0.5h；风险：极低（事件处理器里读 getState 是 zustand 惯用法）。
- 验收：React Profiler 录一段流式输出，`AgentComposer` 的 commit 次数从「每 chunk 一次」降到 0；现有 `composer-slash.test.tsx` / `composer-workspace.test.tsx` 全绿。

## 2. Agent 页流式正文没传 `mode="streaming"`

- 类别：性能 / 体验
- 证据：`src/mainview/app/agent/message.tsx:665`（尾巴 `<Markdown content={tail} />`）、`src/mainview/app/agent/timeline.tsx:642`；对照 `src/mainview/app/chat/message.tsx:487`（对话页传了 `mode={isStreamingMessage ? "streaming" : "static"}`）；`src/mainview/components/markdown.tsx:22`（默认 `static`）、`:25-28`（注释写明 streaming 用来处理半截围栏 / 表格）
- 机制：`Markdown` 组件自己的注释说明生成中应传 streaming，否则半截代码围栏 / 表格每来一个 token 会把下方段落闪成另一个样子。Agent 页的流式尾巴走默认 static：每个增量整段重解析，且未闭合语法不做补全。Streamdown 在 streaming 模式下按块缓存、只重算最后一块——这一点是库内部行为，**未证实**，但「对话页传了、Agent 页没传」是确定的不一致。
- 改法：`message.tsx:665` 改为 `<Markdown content={tail} mode={streaming ? "streaming" : "static"} />`。`markdown.tsx:36` 的 `components={{ img: ... }}` 每次渲染是新对象，提到模块级常量（避免击穿 Streamdown 的 memo，未证实其比较方式）。
- 工时：0.5h；风险：低。
- 验收：流式输出一段含代码围栏与表格的回答，围栏未闭合期间下方内容不闪；Profiler 中尾巴 Markdown 的单次渲染耗时下降。

## 3. 打开会话时轨迹事件被全量加载两次

- 类别：性能
- 证据：`src/mainview/app/agent/conversation.tsx:52-58`（`eventsQuery` 全量）、`:211-228`（追平 effect）；`src/bun/agent.ts:384-391`
- 机制：追平 effect 在 `running === false` 时立即 `catchUp()`。会话刚挂载时 store 已被 `setConversationId` 清空，`known.length === 0` → `afterId = 0` → 等价于又一次全量 `listAgentEvents`，与 `eventsQuery` 并发。每次打开会话都是两份全量 SQL + 两份全量 RPC 负载（单条 tool_end 输出上限 24000 字符，见 `src/bun/agent-spill.ts:24`；write_file 的 args 是整份文件内容，不裁剪）。
- 改法：`catchUp` 开头加守卫：`eventsQuery` 未成功或 `known.length === 0` 时直接返回，把首次加载留给 `eventsQuery`。
- 工时：1h（含一条测试）；风险：低。
- 验收：mock `rpcClient.listAgentEvents`，挂载 `AgentConversation` 后断言只被调用一次且第一次不带 `afterId`；运行中仍按 4 秒追平。

## 4. 三处界面入口失效

- 类别：可靠性 / 体验
- 4a 运行中「排队发送」按钮永远点不了
  - 证据：`composer.tsx:324-325`（`canSend` 含 `&& !busy`）、`:767`（`disabled={!canSend || ...}`）、`:763` 与 `:775-776`（busy 时提示文案与图标都是「排队」）
  - 机制：busy 且有输入时渲染的是排队按钮，但 `canSend` 在 busy 时恒为 false，按钮恒 disabled；只有回车（`:581-583`）能排队。
  - 改法：拆成 `canSend`（非 busy）与 `canQueue = busy && input.trim().length > 0`，按钮 `disabled={!(busy ? canQueue : canSend) || ...}`。
- 4b 用户消息右键「回到这条提问」无反应
  - 证据：`message.tsx:383-390`（动作只 `setConversationRevertOpen(true)`）、`:430-443`（弹窗元素由 hook 返回）、`:517`（`AgentUserMessage` 只解构了 `actions`）、`:519-539`（未渲染弹窗）
  - 机制：弹窗只在 `MessageActionBar` 里渲染（`:487-488`），用户消息没有操作条，状态置 true 后没有任何东西挂载。
  - 改法：`AgentUserMessage` 解构并渲染 `conversationRevertDialog`（放在 `menu.node` 旁）。
- 4c 侧栏「归档」分组不可达
  - 证据：`session-sidebar.tsx:459`、`:465-467`（默认 `includeArchived: false`）、`:524`、`:784`（`archived.length > 0 || showArchived` 才显示分组）、`:792`（唯一的 `setShowArchived` 入口在分组标题上）；`src/bun/agent.ts:1291`（后端按参数过滤掉归档行）
  - 机制：默认查询不含归档 → `archived` 恒为空 → 分组标题不渲染 → 无法把 `showArchived` 置 true。归档后的会话从侧栏再也看不到、无法恢复（仅 ⌘K 搜索还能搜到，因为搜索不过滤归档）。
  - 改法：后端 `listAgentSessions` 返回值旁加 `archivedCount`（一条 `count(*)`），分组显示条件改为 `archivedCount > 0 || showArchived`。
- 工时：合计 2.5h（含三条测试）；风险：低。
- 验收：新增测试——busy 且有输入时按钮可点并调用 `followUpAgentMessage`；用户消息右键选「回到这条提问」后确认弹窗出现；归档一个会话后「归档」分组出现，展开能看到并恢复。

## 5. 自动滚动无条件贴底

- 类别：体验
- 证据：`src/mainview/app/agent/conversation.tsx:159-163`；对照 `src/mainview/app/chat/index.tsx:84-100`、`:136-149`（对话页已有跟随模式 + 回到底部按钮）
- 机制：effect 依赖末条消息的 content / reasoning 与 `events.length`，每个 chunk 都执行 `el.scrollTop = el.scrollHeight`，不判断用户是否已上翻。长回合里想回看上一段时每 40ms 被拽回底部。对话页注释（`chat/index.tsx:82-83`）已把这点列为「最烦人的一件事」并修了，Agent 页没同步。
- 改法：把对话页那段抽成 `hooks/use-follow-scroll.ts`（`followRef`、`handleScroll`、`jumpToBottom`、切会话复位），两页共用；Agent 页 `thread-scroll` 加 `onScroll` 与「回到底部」按钮。
- 工时：2h；风险：低。
- 验收：流式中上翻 200px 后视口不再跳动，出现回到底部按钮；点按钮后恢复跟随；切会话后默认贴底。

## 6. 消息列表无 memo：每个增量 / 事件重渲染全部消息

- 类别：性能
- 证据：`conversation.tsx:36-37`（订阅整份 messages / events）、`:246`（全量 map）、`:166-175`（`eventsByMessage` 整表重建）、`:181-184`（`artifactsByMessage` 依赖 `activeMessages`，每个 chunk 重算）、`:273`（`?? []` 每次新数组）、`:189-196`（回调每次新建）；`message.tsx:508`、`:546`（两个消息组件都没 memo）、`:228-446`（`useMessageActions` 每次渲染重建 3 个 `useMutation` 选项、动作数组与两个弹窗元素）；`stores/agent.ts:419-423`
- 机制：`appendChunk` 已经保留了旧消息对象的引用（`stores/chat.ts:266-272` 只替换最后一条），但消息组件没 memo，这份引用稳定性没被利用：每个 chunk（约 25 次 / 秒）所有历史消息都重跑 `useMessageActions`、`usePiContextMenu`、`AgentEventTimeline` 的 `items.map`（每个 text 项一个 `Markdown`）。每条 agentEvent 到达时 `eventsByMessage` 整张 Map 重建，所有消息拿到新数组引用；`artifactsByMessage` 因依赖 `activeMessages` 每个 chunk 也整表重建。即使直接加 memo，这三处不稳定引用也会让它失效。100 条助手消息 × 20 个时间线项的会话，每秒约 5 万次组件函数调用。
- 改法（一个 PR）：
  1. `AgentAssistantMessage` / `AgentUserMessage` 包 `React.memo`。
  2. `eventsByMessage` 做引用复用：用 `useRef` 保存上一份 Map，新桶与旧桶长度相同且末元素 id 相同则沿用旧数组；模块级 `EMPTY_EVENTS` 常量替换 `?? []`。
  3. `artifactsByMessage` 的依赖从 `activeMessages` 换成消息 id + role 的签名串，并对桶做同样的引用复用。
  4. `openArtifact` / `openArtifactsTab` 只碰 `getState()`，提到模块级函数。
  5. `AgentEventTimeline`、`ToolRow`、`ToolGroupRow`、`SubagentGroup` 包 memo（`timeline.tsx:386`、`:441`、`:541`、`:622`）。
- 工时：5h；风险：中低（memo 漏掉某个 prop 会导致不刷新，靠现有 `message.test.tsx` 19 条用例兜底）。
- 验收：Profiler 下流式期间只有最后一条助手消息 commit；新增测试——渲染 50 条消息，对末条 `appendChunk`，用渲染计数 spy 断言前 49 条渲染次数不变；追加一条属于末条消息的 agentEvent 同理。

## 7. 时间线 key 带 index，且子智能体分组恒排末尾

- 类别：体验
- 证据：`timeline-model.ts:156-160`（子智能体分组在主线事件全部处理完之后统一 push）、`:112`（`subagentOrder.includes` 线性查找）；`timeline.tsx:641`、`:648`、`:672-687`（所有 key 都拼了 `-${index}`）；`:388`、`:443`、`:553`（展开状态是组件内 `useState`）
- 机制：子智能体分组始终位于列表末尾，主线每新增一项它的 index 就 +1 → key 变化 → React 卸载重挂 → 用户展开的子智能体详情在下一条事件到来时自动收起。排在末尾本身也打乱因果顺序：派发之后主 Agent 又说的话、又调的工具都显示在子智能体分组上方。
- 改法：`buildTimelineItems` 主循环里首次遇到某个 `subagentId` 时就地插入占位项，结束后回填 start / end / children；`subagentOrder` 换成 Map 的插入序。key 改为 `类型前缀 + 事件 id`（tool 用 start.id、group 用首个 start.id、其余用自身 id），去掉 index——同一列表里这些 id 本来就唯一。
- 工时：2h；风险：低（纯函数，有 `timeline-model.test.ts`）。
- 验收：单测——task 派发之后还有主线 text 事件时，subagent 项位于两者之间；组件测试——展开子智能体分组后追加一条主线事件，`aria-expanded` 仍为 true。

## 8. 右侧面板：浏览器页签、终端回放、PTY 回收

- 类别：可靠性
- 8a 浏览器每次导航新增一个页签
  - 证据：`right-panel.tsx:213-216`（`onChange` 调 `openPanelTab({ kind: "browser", url })`）；`stores/agent.ts:51-52`（页签身份 = `browser:${url}`）、`:367-375`（找不到同 key 就追加）、`:82-89`（只持久化 kind）、`:66-80`
  - 机制：地址栏回车后新 URL 的 key 与当前页签（`browser:` 空串或旧 URL）不同 → 追加新页签，旧的留着。访问 3 个地址就有 4 个浏览器页签；持久化只存 kind，重启后变成多个空白浏览器页签，越积越多。
  - 改法：store 加 `updatePanelTab(index, tab)`，`BrowserTab.onChange` 原地更新当前页签的 url；`loadPanelTabs` 对 browser kind 去重。
- 8b 终端重挂载时回放重复
  - 证据：`terminal-tab.tsx:113-118`（先写 `info.buffer`，再写 `takeOutput` 取到的 pending）；`stores/terminal.ts:82-89`（无订阅者时同一段 data 同时进 pending 与 buffer）
  - 机制：页签切走期间的输出既在 buffer 里也在 pending 里，切回来 attach 时两份都写进 xterm，这段输出显示两遍。
  - 改法：attach 时只回放 buffer 并丢弃 pending。更彻底：bun 侧本来就保留 scrollback（`src/bun/terminal-sessions.ts:135`、`:231-243`），webview 可以不再维护 200KB 的 buffer 副本——`appendOutput` 只分发给订阅者，重挂载时调 `getTerminal(id)` 取 scrollback；需要让 `getTerminal` 返回前先 flush 该会话的 32ms 缓冲以保证顺序。这样每个输出帧不再做一次 `set()` + 200KB 字符串拼接切片。
- 8c PTY 无回收
  - 证据：`terminal-tab.tsx:100-106`（只在 webview store 里按 cwd 找已有会话）、`:91-97`（卸载只销毁 xterm，按设计不杀 shell）；`stores/agent.ts:377-384`（关页签不调 `closeTerminal`）；`src/bun/terminal-sessions.ts:219-229`（`listTerminals` 存在但没有对应 RPC）
  - 机制：每换一个工作区就起一个新 shell；webview 刷新 / HMR 后 store 清空，旧 PTY 在 bun 侧成为孤儿，直到应用退出才被 `closeAllTerminals` 回收。
  - 改法：加 `listTerminals` RPC，终端页签挂载时先认领 bun 侧同 cwd 的存活会话；关闭 terminal 页签时关掉当前会话；bun 侧加上限（例如 4 个，超出关最久未写入的）。
- 顺带：`terminal-sessions.ts:139-143` 与 `:161-165` 会各触发一次 exit 回调，第一次 exitCode 恒为 0，界面会先闪一次「已退出 0」。
- 工时：4h（8a 1.5h、8b 最小修 0.5h、8c 2h）；风险：中低。
- 验收：浏览器页签连续访问 3 个地址后页签数不变；`stores/terminal` 单测——无订阅期间追加输出后重新 attach，写入 xterm 的总内容等于输出原文；刷新 webview 后打开终端页签，bun 侧会话数不增加。

## 9. 会话搜索：跨应用泄漏、N+1、无防抖

- 类别：可靠性 / 性能
- 证据：`src/bun/agent.ts:1357-1362`（正文命中不按 app 过滤）、`:1367-1372`（回表也不过滤 app）、`:1375-1381`（每个命中会话再查一次 LIKE）、`:1395`（全部查完才 `slice(0, limit)`）；`src/mainview/app/agent/topbar.tsx:107-111`（每次按键一个查询）；`scripts/agent-capabilities-smoke.ts:347-365`（测试里两个会话都是 agent，测不出泄漏）
- 机制：标题命中限定了 `app = 'agent'`，正文命中没有，所以对话页（chat）的会话只要正文含关键词就会出现在 Agent 搜索里，点开会被当成 Agent 会话打开。常见词命中几百个会话时，先逐个执行几百次 `LIKE '%kw%'` 再截成 20 条。前端没有防抖，输入 5 个字符 = 5 轮上述查询。
- 改法：正文命中改为 join `conversations` 并加 `app = 'agent'`；先按 `updatedAt` 排序取前 `limit` 个会话 id，再用一条 `conversation_id IN (...)` 查询取片段，在 JS 里每会话留 3 条；前端加 200ms 防抖和 `placeholderData: keepPreviousData`。数据量再大时考虑 FTS5，这一步先不做。
- 工时：3h；风险：低。
- 验收：冒烟加一条——`createConversation("x", "chat")` 且正文含关键词，`searchAgentSessions` 不返回它；对 SQL 计数，单次搜索语句数为常数；连续快速输入只发 1 次 RPC。

## 10. 空闲轮询过密，会话列表每次读出末条消息全文

- 类别：性能
- 证据：`session-sidebar.tsx:465-470`（4 秒）、`queue-panel.tsx:19-24`（2 秒，不看是否在跑）、`conversation.tsx:69-73`（5 秒）；`src/bun/agent.ts:1266-1275`（取每个会话末条消息的完整 content）、`:1309`（JS 里才 `slice(0, 160)`）、`:1256-1287` 与 `:1291`（归档会话先参与三条批量查询，之后才被过滤）；`src/bun/rpc/index.ts:6817-6821`（`agentRunState` 已有推送）
- 机制：没有任何回合在跑时，界面仍约每秒 1 次 RPC。其中 `listAgentSessions` 每 4 秒跑 4 条 SQL，预览那条把每个会话最后一条消息的全文（Agent 回答常见数 KB 到数十 KB）读进 JS 再截成 160 字。会话越多、回答越长越浪费。
- 改法：预览 SQL 改为 `substr(m.content, 1, 400)`；`ids` 在 `includeArchived` 为 false 时先过滤掉归档行；侧栏 `refetchInterval` 改成函数——有会话 running 才 4 秒，否则关闭，并在 `lib/rpc.ts` 的 `agentRunState` / `agentTodos` 处理器里 invalidate `["agent-sessions"]`（`chatDone` 已经在做，见 `lib/rpc.ts:102`）；队列面板只在 `running` 时轮询，或者新增 `agentQueueChanged` 推送；`getAgentRunState` 兜底从 5 秒放宽到 15 秒。
- 工时：4h；风险：中低（推送丢失时侧栏状态点可能滞后，保留低频兜底即可）。
- 验收：空闲 60 秒统计 RPC 次数，从约 60 次降到个位数；运行中侧栏状态点 / 待办进度仍在 4 秒内更新；`agent-capabilities-smoke.ts` 会话段全绿。

## 11. 运行中重进会话，流式尾巴错位或不可见

- 类别：可靠性
- 证据：`message.tsx:613`（`tail = content.slice(flushedTextChars(events))`）、`timeline-model.ts:58-64`；`src/bun/agent.ts:2934-2937`、`:2961-2969`（助手正文只在回合结束写库）、`:3229-3236`（`getAgentRunState` 不带已生成正文）；`session-sidebar.tsx:560-568`（切会话清空 `activeMessages`）；`stores/chat.ts:264-283`（chunk 只是往本地已有 content 上追加）
- 机制：「尾巴 = 整条正文减去已落成 text 事件的前缀」成立的前提是本地 content 从回合开头完整累积。代码注释明确要支持的场景（`conversation.tsx:63-67`：刷新窗口、切走再切回、后台起的运行）下这个前提不成立：重进时库里正文为空，本地 content 从重进那一刻的 chunk 开始累积，而 `flushedTextChars` 返回整轮已落成的字符数 N。结果是新流出的文字在累计超过 N 个字符之前完全不显示，超过后显示的是被切掉前 N 个字符的错位片段，直到 `chatDone` 用全文覆盖才恢复。「处理中 · N 秒」照常在走，所以看起来像「在跑但不出字」。
- 改法：
  1. `chunk-flusher.ts` 给每个 chunk 带上 `offset`（该增量在整条正文 / 思考里的起始位置）；`appendChunk` 按 offset 对齐——重叠部分丢弃、缺口用空串占位——使增量幂等，丢推送也不再错位。
  2. bun 侧维护 `liveText: Map<conversationId, { messageId, content, reasoning }>`（`runAgentTurn` 里已有 `fullText` / `reasoning`），`getAgentRunState` 返回前先 `flusher.flushNow()` 再带上这份快照；`conversation.tsx` 的 `runStateQuery` effect 拿到后通过 `mergeServerMessages` 的「取更长者」规则灌进本地。
- 工时：7h；风险：中（改动推送协议字段，网页端 SSE 通道同源受益；需要同步 `chat.test.ts` 与 `chunk-flusher.test.ts`）。
- 验收：在 `agent-live-check.ts` 的桩服务上加场景——回合中途模拟切走再切回（清空 store 后重新 `getAgentRunState` + `listAgentEvents`），断言「时间线 text 项 + tail」拼起来等于此刻 bun 侧的 `fullText`；`stores/chat` 单测覆盖 offset 重叠 / 缺口两种情况。

## 12. 历史加载：全量、无列裁剪、回焦即重取

- 类别：性能
- 证据：`src/bun/chat.ts:309-323`（全部消息，`orderBy(messages.createdAt)`，该列无索引，`src/bun/db/schema.ts:111-114`）；`src/bun/agent.ts:384-391`（`select()` 全列全行）、`:2638-2656`（tool_start 的 args、tool_end 的 output 全文入库）；`src/mainview/components/providers.tsx:4`（`QueryClient` 全默认：`staleTime 0` + 回焦重取）；`conversation.tsx:56-58`（重取结果用 `setEvents` 整体替换）
- 机制：打开旧会话 = 一条 RPC 返回全部消息 + 一条返回全部事件（含每个工具的完整输出与 write_file 的整份文件内容），而工具行默认折叠，output 只在展开时才用得上。窗口每次回焦，`["conversation"]`、`["agent-events"]`、`["agent-snapshots"]` 等全部重取一遍同样的全量数据。另外重取结果走 `setEvents` 整体替换：快照之后、effect 执行之前推送到达的事件会被旧快照覆盖掉，要等 4 秒追平才补回。
- 改法（分两步，可拆两个 PR）：
  1. 低成本：`["agent-events"]` 设 `staleTime: Infinity` + `refetchOnWindowFocus: false`（推送 + afterId 追平已经在维护它）；`["conversation"]` 在流式期间关掉回焦重取；`setEvents` 在同会话内改走 `mergeEvents` 语义；`getConversation` 改为 `orderBy(messages.id)`。
  2. 列裁剪 + 懒加载：`listAgentEvents` 增加 `compact` 选项，`tool_end.output` 只返回前 2000 字符 + `outputLength`，`tool_start.args` 超过 8KB 时返回截断串 + `argsLength`；新增 `getAgentEvent({ id })`，`ToolDetail` 展开时按需取全文（`timeline.tsx:322`）。`text` 事件必须保留全文（尾巴计算依赖其长度）。编辑类工具折叠态的 +/- 计数依赖完整 args（`timeline.tsx:395-398`），可改成落库时预算 `added / removed` 写进 args 的旁路字段，或对 edit 家族不截断。
  3. 分页（更远期）：消息按 id 倒序取最近 N 条，上翻再取。它与 `mergeServerMessages`、`artifactsByMessage` 的「已不在这屏里」判断耦合较深，建议排在第 6 条之后单独评估。
- 工时：步骤 1 约 2h，步骤 2 约 6h，合计 8h；风险：步骤 1 低，步骤 2 中。
- 验收：构造 200 次工具调用的会话，打开时 `listAgentEvents` 响应体积下降一个数量级；展开任一工具行仍能看到完整输出；回焦不再触发事件全量重取；`message.test.tsx` 全绿。

## 13. rpc/index.ts 的 agent 段可抽成独立文件

- 类别：可维护性
- 证据（规模）：handler 共 66 个，连续位于 `src/bun/rpc/index.ts:4187-4568`（约 380 行），另有 `getAgentWorkspace` 在 `:4776`；对应 schema 在 `:1047-1527`（约 480 行）加 `:1726`；推送接线 `:6810-6882`；网页端白名单的 Agent 段从 `:7076` 起。紧随其后的自动化 / 通知 / ViewState（`:4571-4622`）与 Agent 强相关，可以一起搬。
- 可行性：这 66 个 handler **没有用到任何局部闭包变量**，只依赖模块级 import（`Agent`、`Permissions`、`Snapshots`、`Context`、`Sandbox`、`NotifyHook`、`Hooks`、`Notifications`、`path`、`Utils`、`updateSettings`、`getSetting`）和一个模块级小函数 `goalView`（`:97`）。绝大多数是 1–5 行的薄转发，业务逻辑已经在 `src/bun/agent*.ts` 里。
- 阻碍：
  1. 类型来源：`rpcRequests` 的参数类型靠整体标注 `NonNullable<Parameters<typeof BrowserView.defineRPC<AppRPC>>[0]["handlers"]["requests"]>` 做上下文推断（`:3302-3304`，注释 `:3287-3288` 说明裸对象字面量会集体退化成 implicit any）。子文件需要 `satisfies Pick<RpcRequestHandlers, ...>`，因此要先把这个处理器表类型导出到纯类型模块；子文件用 `import type` 反向引用，不产生运行时环依赖。
  2. `AppRPC` 是单个类型字面量。拆 schema 需要写成 `requests: CoreRequests & AgentRequests`；Electrobun 的 `RPCSchema` 对交叉类型的推断是否完好，**未证实**，需先做一个最小试验。
  3. 少数 handler 含内联业务逻辑（`approveAgentPlan` `:4286-4304` 拼开工提示词并起一轮运行；`revertAgentSnapshot` `:4499-4509` 发通知），应顺手下沉到 `agent-plans.ts` / `agent-snapshots.ts`，让 RPC 层保持纯转发。
- 改法（两步）：第一步只搬 handler——新建 `src/bun/rpc/agent-handlers.ts` 导出 `agentRequests`，`index.ts` 里 `...agentRequests` 展开，schema 不动；第二步验证交叉类型可行后再搬 schema 到 `rpc/agent-schema.ts`。webview 侧 `lib/rpc.ts:119-165` 的 agent 消息处理器同理可抽 `lib/rpc-agent-handlers.ts`，优先级低。
- 工时：第一步 4h，第二步 4h；风险：低（纯搬运，靠 typecheck 把关）到中（schema 拆分）。
- 验收：`tsc --noEmit` 通过且 agent handler 参数无 implicit any；`index.ts` 行数减少 380 以上；三个 agent 冒烟脚本与 `test:smoke` 全绿；网页端白名单行为不变。

## 14. 大组件职责拆分

- 类别：可维护性
- `message.tsx`（710 行）：`useMessageActions`（`:228-446`，219 行）把 3 个 mutation、存笔记、动作清单、2 个弹窗绑在**每条消息**上。建议上提为会话级的 `MessageActionsProvider`：mutation 与弹窗各挂一份，用「目标 messageId」状态驱动，每条消息只保留动作清单的纯计算——同时消掉每条消息约 5 个 MutationObserver，并顺带修掉 4b。`ReasoningRow`、`AgentRunStatus` + `useTicker`、`ArtifactSection` 可各自成文件。
- `session-sidebar.tsx`（806 行）：`SessionRow`（`:139-264`）里手写的弹出菜单与 `composer.tsx:162-231`、`composer-controls.tsx` 里的同类弹层是第三份实现，而 `@components/pi-menu` 已有 `usePiContextMenu`；建议抽 `PiPopoverMenu` 统一。`bucketOf` / `TimeBucketedSessions` / `SessionList`、项目分组计算（`:542-554`）、`openWorkspace` + `rememberWorkspace`（`:582-617`，与 `composer.tsx:96-99` 重复）可抽成 `session-groups.ts`（纯函数，可单测）与 `use-workspace-recents.ts`。
- `composer.tsx`（789 行）：`WorkspacePicker`（`:58-234`）与 `ToolsPanel`（`:237-267`）已是独立组件，直接搬出；斜杠命令分发（`:509-575`）抽 `use-slash-commands.ts`；附件状态与 `attachMutation`（`:297-298`、`:426-458`）抽 `use-composer-attachments.ts`；`--pi-dock-h` 的 ResizeObserver（`:599-615`）抽 `use-dock-height.ts`。
- `composer-controls.tsx`（618 行）：`ModeChip` / `PermissionChip` / `ModelThinkingPicker`（`:227` 起约 215 行）/ `ContextInspector`（`:470` 起）四个互不依赖的控件，按组件拆文件即可。
- `timeline.tsx`（688 行）：`diffLines` / `summarizeEdit`（`:64-151`）被 `review-tab.tsx:15` 跨文件引用，应移到 `timeline-diff.ts`；`toolMeta` / `toolUnitKey` / `groupBreakdown` / `subagentMeta`（`:153-303`、`:511-535`）是纯函数，移到 `timeline-model.ts` 旁的 `tool-meta.ts` 并补单测。顺带统一一处不一致：`ToolRow`（`:395-398`）与 `useSessionChanges`（`review-tab.tsx:47`）都漏了 `apply_patch`，而 `ToolGroupRow`（`:456-460`）与 `ToolDetail`（`:334`）包含它——抽一个 `isEditTool()` 共用。
- 工时：8h（建议按文件分 3–4 个小 PR）；风险：低（以搬运为主），`MessageActionsProvider` 一项为中。
- 验收：单文件降到 400 行以内；现有 7 个测试文件全绿；`apply_patch` 编辑在单行工具行与非 git 工作区的审查页签里都有 +/- 计数。

## 15. 测试与冒烟盲区

- 类别：测试
- 现状：
  - `scripts/agent-capabilities-smoke.ts`：权限规则 / 授权往返 / ask_user / 待办 / 产出物 / 文件树 / 会话管理（重命名、归档、工作区）/ 分叉 / 通知 / 搜索 / 自动化，全程不调模型。
  - `scripts/agent-live-check.ts`：桩服务上的真实循环——流式解析、授权挂起 / 拒绝 / 允许、工具真实执行、排队 / 插话、子智能体、提问与授权落事件、压缩、无头执行、快照回退、Goal 续跑与暂停。
  - `scripts/agent-resilience-smoke.ts`：503 重试、断流续发、空回合提醒、大输出转存读回、子智能体、压缩，同一条任务里叠加发生。
  - 界面单测：`message.test.tsx`（19 条）、`session-sidebar.test.tsx`（14 条）、`composer-slash`、`composer-workspace`、`timeline-model`、`artifact-meta`、`new-session`，以及 `stores/agent.test.ts`、`stores/chat.test.ts`。
- 盲区：
  1. `conversation.tsx` 无测试：首次加载 + 追平的调用次数（第 3 条）、切会话竞态、滚动跟随（第 5 条）。
  2. 运行中重进会话的正文一致性（第 11 条）：三个冒烟脚本都订阅了 `onAgentChunk`，但只验证「一次连续观看」的路径。
  3. `terminal-tab.tsx`、`stores/terminal.ts`、`browser-tab.tsx`、`right-panel.tsx`、`review-tab.tsx`、`inline-interactions.tsx`、`queue-panel.tsx` 零测试（第 8 条的两个缺陷因此没被发现）。
  4. Composer 在 busy 状态下的按钮行为、用户消息右键动作、侧栏归档入口（第 4 条的三个缺陷）。
  5. 搜索只测了同 app 的两个会话（`scripts/agent-capabilities-smoke.ts:347-365`），没有跨 app 反例（第 9 条）。
  6. 没有长会话性能回归保护：无渲染次数断言，也没有「N 条消息 + M 个事件」的基准夹具。
  7. `src/bun/rpc/index.ts` 的推送接线（`:6789-6837`）没有契约测试——bun 侧新增一种推送而 `lib/rpc.ts` 忘了加 handler 时静默丢失；`lib/rpc.ts:177-178` 的注释记录了 `notificationAdded` 就这样漏过一次。
- 改法：随第 3 / 4 / 5 / 8 / 9 / 11 条各自的 PR 带上对应测试；另加两项独立工作——(a) 渲染计数夹具 `renderCountProbe` 加长会话基准用例（配合第 6 条）；(b) 契约测试：从 `AppRPC["webview"]["messages"]` 的键集合与 `lib/rpc.ts` 的 handlers 键集合做类型级或运行时比对，缺失即失败。
- 工时：独立部分 8h；风险：低。
- 验收：上述盲区各有至少一条会在基线上失败、修复后通过的用例；契约测试在人为删掉一个 handler 时失败。

---

## 看起来像问题、但代码已经处理好的点

1. **流式增量逐 token 发 RPC**——已处理。bun 侧 `src/bun/chunk-flusher.ts:13` 统一 40ms 合批，Agent 与对话共用（`src/bun/agent.ts:2564-2568`），收尾前 `flushNow`（`:2927`）保证尾巴不晚于 `chatDone`；终端输出 32ms 合批（`src/bun/terminal-sessions.ts:45`），语音字幕 60ms 节流（`src/bun/rpc/index.ts:6917-6919`）。不要再在 webview 侧叠一层节流。剩下的是后台会话的增量也照发、由 webview 丢弃（`stores/chat.ts:236`）；可以用 `src/bun/view-state.ts:27` 的 `isViewing` 做门控，但必须先完成第 11 条，否则切回时正文缺口更大。
2. **agent_events 只有 `(conversation_id)` 单列索引，覆盖不了 `conversation_id = ? AND id > ? ORDER BY id`**——其实够用。`id` 是 INTEGER PRIMARY KEY 即 rowid，SQLite 二级索引的条目天然以 rowid 结尾，该索引等价于 `(conversation_id, id)`，范围条件与排序都能走索引（`src/bun/db/schema.ts:140`、`src/bun/agent.ts:388-389`）。不需要新增复合索引。
3. **长列表没虚拟化，离屏消息拖慢布局与绘制**——已缓解。`src/mainview/styles/agent-pi.css:1276-1282` 给 `.msg-row` 加了 `content-visibility: auto` + `contain-intrinsic-size`，`.tool-group` 同理（`:1486-1491`），离屏消息跳过布局与绘制。真正的开销在 React 协调层（第 6 条），先做 memo；引入虚拟列表库的收益相对变小，动态高度与贴底滚动的风险却不小，不建议现在做。（旧版 WebKit 是否支持该属性取决于系统 WebView 版本，未证实。）
4. **xterm 卸载泄漏**——已处理。`terminal-tab.tsx:91-97` 依次 `observer.disconnect()`、`disposable.dispose()`、`term.dispose()` 并清空 ref；输出通过 `subscribeOutput` 直写 xterm、不经过 React 状态（`:161-168`、`stores/terminal.ts:67-78`），退订函数由 effect 返回。浏览器页签只有一个 iframe，没有监听器需要清理。
5. **store 订阅粒度**——基本到位。全目录没有 `useAgentStore()` / `useChatStore()` 整 store 订阅，都是标量或单字段选择器（终端页签 `terminal-tab.tsx:34-36` 还特意只订阅三个标量）；例外只有第 1 条列出的 `composer.tsx:286` 与 `composer-controls.tsx:477`。
6. **会话列表 N+1**——已处理。`src/bun/agent.ts:1254-1287` 用三条批量查询（消息条数 / 末条预览 / 待办进度），挂起交互查的是内存 Map（`src/bun/agent-interactions.ts:116-124`）。剩下的问题是预览读全文与轮询频率（第 10 条），不是 N+1。
7. **推送丢失导致轨迹停住**——已处理。运行中按 `afterId` 每 4 秒追平、收尾再补一次（`conversation.tsx:211-228`），`mergeEvents` 按 id 去重排序并过滤会话（`stores/agent.ts:425-436`）；LCS diff 有 400 行上限与结果缓存（`timeline.tsx:73-79`、`:111-150`）。
