# OmniStudio agent 审查：上下文管理 / 压缩 / 快照 / 指令与技能加载

- 基线：origin/main 24199d4（v0.1.4）只读导出；路径均相对 `apps/studio/`，行号为亲自读到的真实行号。
- 依赖库行为取自本机 bun 缓存中**同版本**的 `@earendil-works/pi-agent-core@0.85.1`、`pi-ai@0.85.1`（与 `package.json:32-33` 钉的版本一致），引用时写作「库:文件:行」。基线目录没有 node_modules，凡依赖库行为而未能在库源码里确认的，标「未证实」。
- 已通读：agent-compaction / agent-context / agent-spill / agent-summary / agent-history / agent-checkpoint / agent-snapshots / agent-instructions / agent-skills / builtin-skills、`shared/token-estimate.ts`、`chat-context.ts`，以及 agent.ts 中全部调用点（buildSystemPrompt、makeContextTransform、getOrCreateSession、runAgentTurn 的快照/刷新/重发段、子智能体段）。`skills/` 目录只读了 `listSkills` 调用链（index.ts、sync-engine.ts:250-288、store.ts、metadata.ts 的 hashSkillDir），其余未审。
- 先澄清两个命名：`agent-checkpoint.ts` 是「探索打点/收网」（上下文内替换），**不是**崩溃检查点；基线里没有任何"崩溃后自动续跑"的机制。快照是**每回合一次**（agent.ts:2502-2506），不是每次工具调用一次。

排序口径：收益/成本从高到低。

---

## 1. 裁剪只钉 `messages[0]`，多轮会话里会把「当前回合的任务陈述」裁掉
- 类别：可靠性
- 证据：`src/bun/agent-compaction.ts:40,56-67,79`；调用点 `src/bun/agent.ts:2048`、`agent.ts:999`
- 机制：`compactMessages` 把 `messages[0]` 当任务陈述永久保留，其余从尾部往前装到预算为止。会话的 Agent 实例跨回合复用（agent.ts:2117-2126），所以第 N 轮时 `messages[0]` 是**第 1 轮**的提问；当前回合的 user 消息位于本回合开头，本回合工具输出一旦超过预算，它就落在被丢弃的中段。摘要模式下 `withMemo[0]` 是摘要消息（agent.ts:2042-2045），同样不含本轮提问。结果：长回合中途模型只看得到旧任务 + 最近几条工具结果，忘了这一轮要干什么。
- 改法：`compactMessages` 增加「最后一条 user 消息」钉住规则：找到 `lastUserIndex`，若它落在丢弃区间，则输出 `[head, placeholder, messages[lastUserIndex], ...kept]`（user 后接 assistant，协议合法）。收网结论、摘要消息、手动压缩占位都是合成的 user 消息，需用标记字段排除（给合成消息加 `synthetic: true`）。
- 工时：2h。风险：低（纯函数）。验收：新增单测——三轮会话、第三轮 30 条工具消息超预算，断言输出含第三轮 user 正文；现有 8 条 compactMessages 用例不变。

## 2. Goal 模式系统提示里有每轮都变的进度行，整段前缀缓存每轮作废
- 类别：成本 / 性能
- 证据：`src/bun/agent-goals.ts:189-191,209`；`src/bun/agent.ts:797,2714-2719,3006`（注释 agent.ts:794-795 声称"缓存友好"）
- 机制：`goalPromptSection` 把 `describeGoal()` 拼进系统提示，内容含 `已用 N tokens / 已运行 M 分钟 / 自动续跑 k 次`；回合收尾 `addGoalUsage`（agent.ts:3006）更新这三个数，下一轮开头 `buildSystemPrompt` 重建后与旧值不等就写回（2716-2718）。系统提示在请求最前面，Goal 模式恰恰是自动续跑、历史最长的模式——每次续跑都让系统提示 + 全部历史重新 prefill（本地 llama.cpp 是纯等待，云端是按未缓存价计费）。
- 改法：`goalPromptSection` 只保留目标、验收标准与固定的完成标准；进度行挪到 `goalContinuationText()`（agent-goals.ts:224-232，本来就是每轮的尾部 user 消息）和 `goal get` 的返回里。
- 工时：1.5h。风险：低。验收：单测断言同一目标在 `addGoalUsage` 前后 `goalPromptSection()` 字符串相等；smoke 里连续两次续跑的请求 system 字段逐字节相同，服务端 `cached_tokens` 第二次起 > 0。

## 3. 「实测占用」口径两处错位：扣掉了缓存命中、又拿全量去比"仅消息"预算
- 类别：可靠性 / 体验
- 证据：`src/bun/agent.ts:2613,2619`；`src/bun/agent-context.ts:63-68,78,83`；库:pi-ai `dist/api/openai-completions.js:1193`（`input = prompt_tokens − cached − cacheWrite`）
- 机制：(a) `rememberPromptTokens(conversationId, msg.usage.input)` 记的是**未命中缓存的那部分**。缓存命中越好，占用条和 `get_context_remaining` 报的"已用"越小（60k 的上下文可能显示几百），模型据此放心做大范围读取。(b) 实测值含系统提示 + 工具定义，而 `budgetTokens` 是窗口 60%、只对消息生效的压缩线（agent.ts:1958 只估消息）。8k 窗口下系统提示 + 工具就可能超过 4.8k，第一步起 `percent` 恒为 100，模型每次都收到"已接近压缩线"的劝告（agent-context.ts:97-101）。文件头注释（agent-context.ts:11-12）说的"两个数是同一个判据"只在估算路径成立。
- 改法：2619 改记 `input + cacheRead + cacheWrite`（2613 的统计同理）；`contextUsage` 的 usage 路径改用 `windowTokens` 当分母、另给 `compactAtTokens` 字段，文案区分"窗口占用"与"距压缩线"。压缩发生后调用 `forgetPromptTokens`（否则要滞后一步才回落）。
- 工时：1.5h。风险：低。验收：单测喂 `{input:500, cacheRead:60000}` 断言 used=60500；agent-context.test.ts:60 用例同步更新。

## 4. 摘要失败没有熔断：每一步都可能再等 90 秒；`summarizing` 是死字段
- 类别：可靠性 / 性能
- 证据：`src/bun/agent.ts:1127,2178`（仅声明与初始化，全文无读写）、`agent.ts:2002-2038`；`src/bun/agent-summary.ts:137,192`
- 机制：摘要失败只记日志后退回裁剪，但裁剪结果不落在会话上；下一次模型调用时 `effective > budget` 依旧成立，于是再次发起摘要，再等最长 `SUMMARY_TIMEOUT_MS=90s`。本地模型忙/慢时，40 步回合最坏多等一小时。`Session.summarizing` 注释写"避免并发重复计费"，实际没有任何代码使用。
- 改法：`CompactionHost` 加 `summaryFailures` 与 `summaryCooldownUntil`；失败后本回合内（或 N 分钟、指数退避）直接走裁剪，成功清零；用户中断（signal.aborted）不计失败、不写 warn。删除 `summarizing` 字段（transformContext 在单会话内本就串行）。
- 工时：1.5h。风险：低。验收：pipeline 测试注入恒超时的 fake `models.completeSimple`，连续调 3 次 transform，断言只被调用 1 次。

## 5. 技能清单走 `listSkills()`：每次建系统提示都做部署探测与目录哈希
- 类别：性能
- 证据：`src/bun/agent-skills.ts:69`；`src/bun/skills/index.ts:105-115`；`src/bun/skills/sync-engine.ts:254-268`（267 行 `hashSkillDir`）；`src/bun/skills/store.ts:273-275,526-538`；调用频率 `src/bun/agent.ts:788,2153,2715`
- 机制：提示词只用 `id/name/description`，却调用给 Skills 管理页用的 `listSkills()`：对每条部署记录 `lstat/readlink`，copy 模式还要把中央库技能目录**全量读盘算 sha256**，再对每个技能跑一遍 `resolveAdapters()`。系统提示每轮开头都重建（2715），首轮还连建两次（2153 + 2715），全部是主进程同步 IO。
- 改法：`skillsPromptSection` 改用 `listSkillRows()`（纯 DB，已按 name 排序，字段相同，`assembleManagedSkills` 没有任何过滤）。可选：`buildSystemPrompt` 结果按 `(mode, workspace, 指令文件 mtime, 设置版本)` 做一层 memo，首轮不再重复构建。
- 工时：1h。风险：低。验收：单测 mock `hashSkillDir` 断言零调用；补 `skillsPromptSection` 的首批测试（现有 agent-skills.test.ts 只测了 readSkillFile）。

## 6. `rewind(revertFiles)` 还原到的是「回合开头」，不是「打点时」
- 类别：可靠性（会丢用户/Agent 的改动）
- 证据：`src/bun/agent.ts:1756,1794-1800,2504-2506`
- 机制：`beginCheckpoint` 记的 `atSnapshotId` 是 `session.turnSnapshotId`，即本回合开跑前的快照。Agent 在本回合先改了文件、再打点探索、再 `rewind(revertFiles:true)`，打点之前的改动会被一并还原，而回执文案写的是"已还原工作区到打点时的状态"。打点跨回合保留（session.checkpoint 不随回合清空），跨回合收网时还会抹掉中间回合的全部改动和用户的手工编辑。
- 改法：`beginCheckpoint` 现拍一张快照（`createTurnSnapshot({label:"checkpoint", messageId:null})`，失败则 `atSnapshotId=null` 并在回执里明说不可还原文件）。messageId 为 null 的记录不会出现在消息的"撤销本轮"上（conversation.tsx 按 messageId 建索引）。
- 工时：2h。风险：低-中（多一次同步 git add，见第 13 条）。验收：集成测试——回合内写 a.txt → checkpoint → 写 b.txt → rewind(revertFiles)，断言 a.txt 保留、b.txt 消失。

## 7. token 估算漏掉工具调用参数 / thinking / 图片；压缩预算不扣系统提示与工具定义
- 类别：可靠性
- 证据：`src/shared/token-estimate.ts:40,55-70`（63-65 行非 text 块只计 `[type]`）；`src/bun/agent.ts:1958,996`；`src/bun/agent-context.ts:44-46,59,74`（`toolTokens` 全仓库无人传入）；对照 库:pi-agent-core `dist/harness/compaction/compaction.js:166-187`；测试 `agent-compaction.test.ts:39-44` 只断言 > 0
- 机制：(a) `write_file / apply_patch / edit_file` 的参数常是助手侧最大的内容，却按 `[toolCall]` 约 3 token 计；thinking 块（字段名 `thinking`）与图片同理，图片实际成百上千 token。库自带的估算把 `name + JSON(arguments)` 和 thinking 都计入。后果是"以为没超预算"而不压缩，小窗口下直接超窗。(b) 预算恒为窗口 60%，剩余 40% 要装系统提示（基础约 1.4k 中文字 + AGENTS.md 8KB + 技能清单 + 记忆）+ 全部工具 schema + 输出；8k 窗口下固定开销可能先超 3.2k。(c) 口径误差：CJK 按 1 token/字偏保守（新分词器约 0.6-0.7），代码按 4 字符/token 偏乐观，无自校准。
- 改法：`textOf` 对 `toolCall` 计 `name + JSON.stringify(arguments)`、对 `thinking` 计 `thinking` 字段、图片按固定值（如 1000）；用 WeakMap 按消息对象缓存估算值（现在每次 transform 要全量逐字符扫 4-6 遍）。预算改为 `window − systemPromptTokens − toolTokens − outputReserve`，上限仍取 60%；`toolTokens` 在建会话时对工具 schema 估一次。用第 3 条修正后的实测值算 `实测/估算` 比例（EMA，夹在 0.5-2）乘回估算，自动适配分词器。
- 工时：4h。风险：中（触发点前移，需回归 pipeline 测试）。验收：单测——含 20k 字符 `write_file` 参数的助手消息估算 ≥ 5000；8k 窗口 + 5k 固定开销时预算 < 3k；校准比例单测。

## 8. 摘要切点只认 user 消息：单个长回合和子智能体里摘要永不触发
- 类别：成本 / 可靠性
- 证据：`src/bun/agent-summary.ts:92-94,128-132`；`src/bun/agent.ts:2004-2005,1585-1589`；对照 库:`compaction.js:205-222`（库允许在 assistant 处切）；测试 `agent-summary.test.ts:51` 把"无回合边界 → null"固化成预期
- 机制：`findSummaryCut` 要求切点是下标 ≥ 2 的 user 消息。编码 Agent 的典型形态是一条 user 后跟几十条 assistant/toolResult（上限 40 步），整段没有第二条 user，于是返回 null，摘要整条路径失效，每一步都落到确定性裁剪（历史直接丢，且触发第 9 条的缓存问题）。子智能体只有一个回合，摘要对它等于不存在，注释（agent.ts:1580-1584）却以为它有。默认开启的 `AGENT_COMPACT_MODE=summary` 实际只在多轮会话的回合边界生效。
- 改法：切点放宽为"user 或 assistant 消息开头"（assistant 在前、其 toolResult 紧随，切在 assistant 之前不会拆散配对），仍禁止切在 toolResult 上；若切在回合中间，摘要 prompt 里补一句"当前回合的任务是：<本回合 user 正文>"，并与第 1 条一起钉住当前 user。同时加滞回，否则小窗口会抖动：现在摘要后占用 ≈ keepRecent(25% 窗口) + 摘要(≤20% 窗口)，离 60% 预算只剩约 15% 窗口（8k 下约 1.2k token，一两次工具结果就再摘一次，每次是一整次推理）。建议 `keepRecent = min(0.25W, 0.4×budget)`、摘要 `maxTokens ≤ 0.15×budget`，保证压缩后 ≤ 预算的 55%。
- 已处理、无需再提：摘要输入里的工具结果库内已截到 2000 字符（库:`compaction/utils.js:62,114`）；续写只摘 `[covered, cut)`（agent-summary.ts:151-163）。但工具调用**参数**是全量序列化的（库:`utils.js:93-98`），大 `write_file` 会原样进摘要输入，建议在传入前把超长参数截断。
- 工时：5h。风险：中（切点规则是协议敏感点）。验收：单测——`[user, (assistant,toolResult)×20]` 返回非 null 且切点角色为 assistant；pipeline 测试用 fake models 走通"单回合 → 摘要 → 再涨 → 续写"，断言两次摘要之间至少间隔预算的 30% 新内容。

## 9. 确定性裁剪每步滑窗、去重即时改写旧消息：前缀缓存在压缩区间内基本为零
- 类别：成本 / 性能
- 证据：`src/bun/agent-compaction.ts:60-67,75-79,160-165,175`；`src/bun/agent.ts:1987-1993,2048-2059`（2054 行占位文案含 `dropped` 数）
- 机制：transform 每次都从完整 `messages` 重算，结果不落会话。进入裁剪区间后每新增一条消息，保留窗口起点就前移、占位文案里的"已省略 N 条"也变，第 2 条消息之后的前缀每次请求都不同，缓存只剩系统提示 + head。云端 256K 窗口下相当于每步约 150k token 按未缓存计费。`pruneSupersededReads` 同理：每次整份重读都立刻改写历史中段的旧结果，缓存从那一点起失效一次；对 8k 窗口值得，对大窗口云端是净亏。另有一处正确性缺陷：160-165 行不看后一次读取的 `isError`，后一次读失败（文件被移走/无权限）也会把前面那份完好内容换成占位。
- 改法：`CompactionHost` 增加 `trim: {cutIndex, dropped} | null`；超预算时裁到**低水位**（预算的 70%）并记住切点，之后只要 `head + 占位 + messages.slice(cutIndex)` 仍在预算内就复用同一切点与同一占位文案；`cutIndex > messages.length`、收网、手动压缩时作废。去重加压力门槛（估算 > 预算 50% 或窗口 ≤ 32k 才做），并跳过 `isError` 的后一次读取。
- 工时：4h。风险：中。验收：单测——连续追加 10 条小消息，10 次 transform 输出的前 K 条逐一深相等；去重用例补"后一次读取 isError → 不替换"；smoke 统计 `cacheRead/(input+cacheRead)` 在裁剪区间内 > 50%。
- 未证实：各后端实际缓存命中率未实测，收益量级按缓存定价与 llama.cpp 前缀复用机制推断。

## 10. 历史回填按工具名 LIFO 配对：并行的同名调用结果会对调
- 类别：可靠性
- 证据：`src/bun/agent-history.ts:82,93-100`；`src/bun/agent.ts:2638-2656`（落库未带 toolCallId）；`src/bun/db/schema.ts:120-136`（表无该列）；库:`types.d.ts:230,399-414`（默认 parallel，事件带 toolCallId）、`agent-loop.js:330-372`（先逐个发 start，再并发执行、按完成顺序发 end）；测试 `agent-history.test.ts:52-63` 把 LIFO 固化成预期
- 机制：agent.ts 没设 `toolExecution`，除媒体工具外都是并行执行。模型一次发两个 `read_file(A)`、`read_file(B)` 时事件序列是 start A、start B、end(先完成者)…；LIFO 总把第一个到达的 end 配给**最后**一个 start，常见的"A 先完成"就会把 A 的内容挂到 B 的调用上。换模型 / 切模式 / 重启后回填的历史里，模型看到的是"读 B 得到了 A 的内容"。
- 改法：`agent_events` 加 `tool_call_id` 列（迁移），`recordEvent` 在 tool_start/tool_end 写入 `event.toolCallId`；`pairToolEvents` 优先按 id 配对，旧数据（无 id）退回 FIFO（比 LIFO 更接近常见完成顺序）。顺手：`historyAsAgentMessages` 查询只取 `kind IN (tool_start, tool_end) AND subagent_id IS NULL`，并用 `substr(output,1,2001)` 在 SQL 层截断（现在是整表全量读出再丢）；被中断的有副作用调用（bash/write_file/apply_patch）合成文案改成"副作用可能已发生，先检查再重做"。
- 工时：3h。风险：低-中（DB 迁移）。验收：单测——start A、start B、end A、end B（带 id）断言各归其主；无 id 的旧行走 FIFO；迁移测试。

## 11. 单条工具输出上限固定 24k 字符，不随窗口缩放；读转存文件会二次转存
- 类别：可靠性
- 证据：`src/bun/agent-spill.ts:24,36,95-113`；`src/bun/agent.ts:642-660`；`src/bun/agent-compaction.ts:63-64`；`src/bun/agent-tools.ts:140`
- 机制：24,000 字符 ≈ 6k token（英文）到 24k token（中文，按本仓库口径），而 8k 窗口的消息预算只有 4.8k。`compactMessages` 无条件保留最后 4 条，所以一次大读取就能让请求超窗（服务端 400 或模型输出错乱），压缩兜不住。另外 `read_file` 自身上限 60k 字符，模型按提示去读转存文件但忘了带 offset/limit 时，结果再次超过 24k → 钩子再转存一份一模一样的文件，更快顶到每会话 40 个的上限，把更早的转存挤掉。转存目录只在删会话时清理，没有全局 TTL。
- 改法：`makeToolOutputHook` 里上限取 `clamp(chatContextWindow() × 0.15 × 3, 4_000, 24_000)`；钩子内若工具是 `read_file` 且 `path` 命中 `isSpillPath` 则只截断不再转存，文案提示必须带 offset/limit；`compactMessages` 在"最后 4 条"仍超预算时，对其中超大的 toolResult 做头尾保留式就地截断。启动时清理 14 天前的转存文件。
- 工时：3h。风险：低。验收：单测——8k 窗口下上限约 4k 字符；对转存路径的 read_file 不产生新文件；"最后 4 条超预算"用例断言输出估算 ≤ 预算 × 1.1。

## 12. 第二次 rewind 覆盖第一次；手动压缩后 rewind / checkpoint 的下标失效
- 类别：可靠性
- 证据：`src/bun/agent.ts:1755,1787,1023-1027`；`src/bun/agent-checkpoint.ts:21-27,36-41`；测试 `agent-checkpoint.test.ts:49` 只覆盖"越界不抛错"
- 机制：(a) `session.rewind` 是单值。第二轮"打点→收网"直接覆盖它，而原始 `state.messages` 里第一次探索的中间过程从未删除，于是第一次省下的上下文全部回到窗口，第一份结论也不再注入（RewindState 注释说"只增不减"，实际被替换）。(b) `compactConversationNow` 真的替换了 `state.messages` 却只作废 `summary`，`rewind.at/cutTo` 与 `checkpoint.atMessageCount` 仍是旧下标；消息重新涨过旧 `at` 后，`[at, cutTo)` 之间的**新内容**会被结论吞掉，正是文件头警告的那种难以察觉的故障。
- 改法：`rewind` 改为 `rewinds: RewindState[]`，区间互不重叠，`applyRewind` 按 `at` 降序依次应用；在回合边界（`runAgentTurn` 开头，循环未持有引用的安全点）把已生效的 rewinds 物化进 `state.messages` 并清空列表（同时释放内存）。`compactConversationNow` 先物化再裁剪，并清掉 `checkpoint`（或如实提示打点已失效）。
- 工时：4h。风险：中。验收：单测——两次收网后上下文同时含两份结论且不含两段中间过程；手动压缩后再追加 60 条消息，断言无消息被吞。

## 13. 快照用 `spawnSync` 阻塞主进程；每轮全量扫影子仓库；没有大文件防护
- 类别：性能 / 可靠性
- 证据：`src/bun/agent-snapshots.ts:47,111,140`（同步 + 20s 超时）、`244-249,272-274`（每轮 5 次 spawn）、`288-293,587-596`（先 `snapshotRepoUsage` 全量遍历、后判节流）、`508-536`、`59-80`（排除表无媒体/大文件）、`122-123`（`gc.auto=0`）、`187`（排除表只在缺 `node_modules/` 时写入，升级后新增模式到不了已有仓库）；调用点 `src/bun/agent.ts:2502-2506`；`src/bun/rpc/index.ts:4468-4476` + `agent-snapshots.ts:158-165,649`
- 机制：回合开始在 Bun 主进程同步跑 `add -A`、`diff --cached`（结果只在 ls-files 失败时才用，属多余）、`ls-files`（整份文件列表读进内存只为数行数）、`commit`、`rev-parse`，期间 RPC、其它会话的流式输出、UI 推送全部卡住。系统提示还主动引导模型把图片/语音/视频 `media_export` 进工作区（agent.ts:736-737），而快照无体积上限：GB 级视频会被完整压缩进影子仓库，或在 20s 超时被杀 → 本轮没有撤销入口，且之后每轮都重试、每轮卡 20s。每次快照还会在节流判断**之前**遍历 `.git`（最多 2 万个文件逐个 stat）；松散对象一多，扫描在 2 万处截断，字节数成了下限，256MB 阈值可能永远触发不了，而 `gc.auto=0` 又关了 git 自己的维护。`listAgentSnapshots` 每次打开会话 / 每轮结束失效重取时都要 spawn `git --version` 并再走一遍目录遍历。
- 改法：`runShadowGit` 改 `Bun.spawn` 异步（调用方本就在 async 上下文），去掉 `diff --cached`，文件数用 `git ls-files | wc -l` 等价的流式计数或直接省略；占用改用一次 `git count-objects -v`，并先读 `index.lastGcAt` 判节流；松散对象数 > 2000 也触发 gc；`gitAvailable()` 结果进程内缓存。大文件：`add` 前用 `git status --porcelain -uall` 拿候选，stat 后把超过阈值（默认 50MB，可设）的路径追加进 `info/exclude`，轨迹里说明"N 个大文件未纳入快照"；排除表改成按"版本标记行"增量补写。
- 工时：6h。风险：中（同步改异步要保证"快照先于第一次工具调用"）。验收：1 万文件夹具下快照期间并发 RPC 延迟 < 50ms；工作区放 1GB 稀疏文件，快照 < 2s 且影子仓库不增长；节流期内零目录遍历（mock readdirSync 计数）。

## 14. 回退不可撤销且悬空对象会被立即清掉；快照历史永不收缩；失效工作区的仓库永不清理
- 类别：可靠性 / 体验
- 证据：`src/bun/agent-snapshots.ts:455-468`（`add -A` 后直接 `read-tree --reset -u`）、`612`（`gc --prune=now`）、`584-586`（注释称老记录的对象会被回收）、`49,285`（只裁索引）、`87-93`（一个工作区一个仓库）；`src/bun/rpc/index.ts:4499-4508`
- 机制：(a) 回退前的当前状态只进了索引、没有提交；`read-tree` 之后那些 blob 悬空，下一次 `gc --prune=now` 直接删掉。用户误点"撤销本轮"后，本轮之后的全部改动（含用户手工编辑，以及同一工作区里**别的会话**的后续回合——仓库按工作区共享）不可找回。(b) 所有快照提交都是 HEAD 的祖先，`gc` 永远不会回收它们；`MAX_RECORDS=200` 只裁 index.json，584-586 行的注释与行为不符，影子仓库只增不减。(c) 全仓库没有任何代码删除 `agent-snapshots/<工作区>` 目录，工作区被删/改名后仓库永久残留。
- 改法：`revertToSnapshot` 在 `read-tree` 前先提交一张"回退前"快照（复用 createTurnSnapshot，label=回退前，messageId=null）并在结果里返回 `undoId`，UI 提供"撤销这次回退"；`gc` 改用 `--prune=2.weeks.ago`。历史截断：索引裁剪时把最老保留记录的 sha 写进 `.git/shallow` 再 gc，更老的对象才真正可回收。启动时 `pruneStaleSnapshotRepos()`：`index.workspace` 不存在或最后快照超过 30 天的仓库整目录删除（先落日志）。预览里补一句"会同时撤销此工作区内其它会话在该快照之后的改动"。
- 工时：4h。风险：中（shallow 截断要有回退测试兜底）。验收：回退后用 `undoId` 再回退，文件逐字节恢复；250 轮后 `git rev-list --count HEAD` ≤ 200；指向不存在工作区的仓库在启动清理后消失。
- 未证实：工作区内嵌套 git 仓库/子模块在 `add -A` 下只会记成 gitlink、内容不进快照，"撤销本轮"对其静默无效——按 git 语义推断，未实测。

## 15. AGENTS.md 上限固定 8KB 且按字节硬切；最具体的一层最先被丢
- 类别：体验 / 可靠性
- 证据：`src/bun/agent-instructions.ts:33,148-173,275-280,331`；数据点：本仓库根 `AGENTS.md` 为 40,968 字节
- 机制：上限不看窗口，云端 256K 窗口也只给 8KB——在 OmniStudio 自己的仓库里跑 Agent，根 AGENTS.md 只进得去前 20%，且在字节位置拦腰截断（可能断在代码围栏或列表中间）。截断按"用户级 → 根 → … → 工作区"顺序消耗预算，根文件一大，工作区那层（最贴近现场的约定）整份被丢；331 行注释说"从后往前砍"，实际砍掉的正是它想保的部分。每轮重建时同步读盘、无 mtime 缓存（量小，单独不值得修，可并入第 5 条的 memo）。
- 改法：默认上限随窗口取 `clamp(windowTokens × 0.04 × 3 字节, 8KB, 32KB)`（用户显式设置优先）；截断复用现成的 `splitInstructionBlocks` 在段落边界收口；预算分配改为先给最深一层保底 25%，剩余再按根 → 工作区顺序分配。
- 工时：2.5h。风险：低。验收：单测——根 40KB + 子包 2KB 时子包完整保留；截断点不落在代码围栏内；云端窗口下默认上限为 32KB。

---

## 看起来像问题、其实已经处理好的 3 点（不必重复建议）

1. **压缩/收网后的协议残局**：裁剪后尾部若以工具结果开头会被剥掉（`agent-compaction.ts:69-73`）；摘要切点不会落在 toolResult 上（`agent-summary.ts:126-132`）；收网后留下的落单 toolCall 由 pi-ai 自动补一条合成结果（库:`pi-ai dist/api/transform-messages.js:125-184`）；历史回填时未配对的调用也补了合成结果（`agent-history.ts:178-196`）。
2. **易变内容不进系统提示**：当前时间、按问题召回的记忆、hook 上下文、附件路径都拼在本轮 user 消息里（`agent.ts:2720-2721,2747-2749,2776-2777`）；系统提示只有内容真的变了才写回（`agent.ts:2716-2719`）；常驻记忆排序刻意不含 updatedAt（`memory.ts:1044-1055`）；技能清单按 name 稳定排序（`skills/store.ts:273-275`）；`sessionId` 已透传给缓存感知后端（`agent.ts:2185-2187`）。例外只有第 2 条的 Goal 进度行。
3. **恢复时不会重放有副作用的步骤**：失败回合重发走 `agent.continue()`，只摘掉末尾 error/aborted 的空壳助手消息，已成功的工具结果留在上下文里不重跑（`agent.ts:2775-2818`；`agent-retry.ts:107-116`）；进程崩溃后没有自动续跑，下一次用户发话时从库回填，被中断的调用标注"回合被中断了"（`agent-history.ts:188-190`），当前 prompt 也不会重复（`agent-history.ts:130-132`）。另：快照索引被篡改的防护（`agent-snapshots.ts:330-337`）、转存路径的软链防护（`agent-spill.ts:63-82`）也都到位。

## 跨切片备注（不计入上面 15 条，供 agent-core 切片参考）

- `getOrCreateSession` 在**模式**或工作区变化时也整会话重建（`agent.ts:2117-2136`），并且一律记一条"模型已切换：X → X"。Plan → 批准 → 执行是高频路径，重建意味着规划阶段读到的文件内容被回填逻辑截到 2000 字符/条（`agent-history.ts:22,110-116`）、摘要与收网状态丢失、前缀缓存全失。可考虑模式切换时保留 Agent 实例，只替换 `state.tools` 与 `systemPrompt`。

## 测试覆盖面观察

- 纯函数覆盖较好（compaction / history / instructions / spill / snapshots 共约 1,900 行测试）。
- 缺口：摘要路径在流水线里没有任何用例（`agent-compaction-pipeline.test.ts` 三条都是收网 + 裁剪）；`skillsPromptSection` 零测试；多次 rewind、手动压缩与 rewind 的组合无测试；`agent-history.test.ts:52` 与 `agent-summary.test.ts:51` 把第 10、8 条的缺陷固化成了预期行为，修复时需同步改写。
