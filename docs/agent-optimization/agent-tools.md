# OmniStudio agent 模块审查：工具集 / 沙箱 / 钩子 / 产物 / MCP

- 基线：origin/main 24199d4（v0.1.4）只读导出，`agent-baseline/apps/studio/`
- 路径均相对 `apps/studio/`；行号为本次亲自读到的真实行号
- 通读：`src/bun/agent-tools.ts`（1472 行）、`agent-sandbox.ts`（790）、`agent-hooks.ts`（322）、`agent-artifacts.ts`（386）、`mcp.ts`（825）、`permissions.ts`（858）、`apply-patch.ts`（497）、`agent-spill.ts`（222）、`runtimes/proc.ts`、`shell.ts`、`shutdown.ts`
- 局部：`agent.ts` 调用点（625-661、838-964、1050-1087、1500-1705、2130-2267、2715-2775、3185-3227、385-415）、`agent-interactions.ts:126-228`、`kb-mcp.ts`（它是对外的 MCP **服务端**，不是 agent 工具接入点，未展开）、`mcp-playground.ts`（纯调试页）
- 实测（本机 Linux、bubblewrap 0.9.0、bun）：第 1、2、3、6 条的关键行为做了最小复现，见各条「证据」
- 限制：基线没有 `node_modules`，`@earendil-works/pi-agent-core@0.85.1` 内核行为（工具默认并行与否、abort 的传播方式）无法对照源码，相关处标「未证实」

排序口径：收益/成本从高到低。

---

## 1. edit_file 用 `String.replace` 写入，`new_str` 里的 `$$`、`$&`、`` $` ``、`$'` 被当成替换序列，静默写坏文件

- 类别：可靠性（数据正确性）
- 证据：`src/bun/agent-tools.ts:567-569`（非 replace_all 分支走 `original.replace(params.old_str, params.new_str)`）；`replace_all` 分支（568）用 split/join，不受影响
- 机制：JS 的 `replace(string, string)` 仍然解释替换串里的特殊序列。实测 `"PID=OLD".replace("OLD", "echo $$ && x=$'\\n' && y=\"$&\"")` 得到 `PID=echo $ && x=\n' && y="OLD"` —— `$$` 变 `$`、`$'` 被换成匹配点之后的原文、`$&` 被换成 old_str。shell 脚本、Makefile（`$$`）、jQuery、正则替换串都是高频内容；工具返回「Edited … (1 replacement)」，模型和用户都不知道写进去的不是它给的文本。
- 同段另一处：`old_str` 为空串时（559）`split("")` 按字符切，`replace_all=true` 会把 `new_str` 插到每两个字符之间，整份文件报废；没有空串校验。
- 改法：569 改成函数式替换 `original.replace(params.old_str, () => params.new_str)`，或统一用 `indexOf + slice` 拼接；入口处 `if (!params.old_str) return errorResult(...)`；`old_str === new_str` 时直接报「无变化」。
- 工时：0.5h　风险：极低
- 验收：新增 `agent-tools.edit.test.ts`：new_str 含 `$$`/`$&`/`` $` ``/`$'` 四种序列，落盘内容逐字节等于 new_str；空 old_str 返回错误且文件不变。

## 2. Linux bwrap 后端对「凭据文件」用 `--tmpfs`，bwrap 直接启动失败 —— 沙箱一开，所有命令都跑不起来，还会被识别成「沙箱拦截」去请用户跳过沙箱

- 类别：可靠性 / 安全（训练用户习惯性绕过沙箱）
- 证据：`src/bun/agent-sandbox.ts:391-394`（对 `existingCredentialPaths()` 全部 `--tmpfs`）；清单里 `.netrc`/`.npmrc`/`.git-credentials`（412-414）是**普通文件**；`explainSandboxDenial` 的模式包含 `bwrap:`（729）；测试只覆盖了目录 `.ssh`（`src/bun/agent-sandbox.test.ts:232-246`），没有真实 bwrap 端到端
- 实测：`bwrap --ro-bind / / --dev /dev --tmpfs /etc/hostname true` → `bwrap: Can't mkdir /etc/hostname: Not a directory`，退出码 1；换成目录则 0。
- 机制：tmpfs 只能挂在目录上。用户只要有 `~/.npmrc`（Node 开发者几乎必有）或 `~/.git-credentials`，`workspace-write` / `read-only` 下每条 bash 都在 bwrap 阶段失败、命令本体一行没跑。随后 `agent-tools.ts:837-849` 因输出含 `bwrap:` 判定为沙箱拦截，弹「跳过沙箱重试」；用户点「始终允许」后沙箱名存实亡。
- 改法：`bwrapArgs()` 里按 `statSync(target)` 分流：目录 `--tmpfs <dir>`，普通文件 `--ro-bind /dev/null <file>`；软链先 `realpathSync` 再判。把「路径 + 类型」封成 `credentialMounts(): {path, kind: "dir"|"file"}[]` 供单测注入。
- 工时：2h　风险：低
- 验收：单测：假 HOME 下同时建 `.ssh/` 与 `.npmrc`，断言 argv 含 `--tmpfs …/.ssh` 与 `--ro-bind /dev/null …/.npmrc`；加一条 Linux 真实 bwrap 端到端（`bwrapAvailable()` 为真才跑）：有 `.npmrc` 时 `echo ok` 退出码 0，沙箱内 `cat ~/.npmrc` 读到空。

## 3. glob 工具：`**/` 不匹配零层目录 —— 工具描述里举的两个例子自己就匹配不全

- 类别：可靠性 / 体验
- 证据：`src/bun/agent-tools.ts:342-362`（`**` → `.*`，其后的 `/` 原样保留）；描述里的示例 `**/*.ts`、`src/**/*.test.ts`（428）；调用点 439-445
- 实测（照抄该函数）：`**/*.ts` 对 `index.ts` → false；`src/**/*.test.ts` 对 `src/a.test.ts` → false；`*.{ts,tsx}` 对 `a.ts` → false（花括号被当字面量转义）。
- 机制：`**/*.ts` 生成 `^.*/[^/]*\.ts$`，强制至少一个 `/`，根目录文件全部漏掉；结果又是平静的 `(no matches)` 或一份不完整清单，模型据此得出「没有这个文件」。glob 的空结果也没用 `NO_MATCH_HINT`（445 vs grep 的 503）。Windows 上 `path.relative` 给反斜杠（441），任何带 `/` 的模式都不命中（未证实：无 Windows 环境）。
- 改法：`globToRegExp` 里把 `**/` 译成 `(?:.*/)?`、末尾 `/**` 译成 `(?:/.*)?`；支持 `{a,b}` → `(?:a|b)`；匹配前把 rel 统一成 `/` 分隔；空结果复用 `NO_MATCH_HINT` 并注明「已跳过 dot 目录与 node_modules/dist/build 等」（`walkDir` 的 330 行让 `build/**` 这类查询永远为空且无提示）。
- 工时：1h　风险：低
- 验收：表驱动单测覆盖上述 4 个用例 + `a/**`、`**`；临时目录里根级与嵌套各放一个 `.ts`，工具返回两条。

## 4. 停止信号没有贯通：`task` 子智能体在用户按停止后继续跑；web_fetch、MCP 调用也不可取消

- 类别：可靠性 / 安全（用户已喊停仍在写文件、跑命令、烧 token）
- 证据：
  - `src/bun/agent-tools.ts:1225-1238`，其中 1231 `void signal;` 明确丢弃信号；`ToolContext.spawnSubagent` 签名（61-65）没有 signal
  - `src/bun/agent.ts:1503-1511` `runSubagent` 无 signal 入参；1563 `new Agent(...)` 是独立实例；`stopAgentRun` 只 `session.agent.abort()`（3219-3222）
  - `src/bun/agent-tools.ts:1258-1270` web_fetch 自建 30s controller，不接工具的 signal；`src/bun/mcp.ts:807-814` MCP execute 不收 signal，`callTool` 等满 `CALL_TIMEOUT_MS = 180_000`（30、350-358）
- 机制：停止时父 agent 被 abort，待决授权被置拒绝（3210），但 general 型子智能体带完整工具（`agent.ts:1547-1549`），在 smart 模式下 bash/edit 默认 allow，它会继续调模型、改文件，直到自己收尾或到 `AGENT_SUBAGENT_MAX_STEPS`（1612，默认 12 步）。父工具的 promise 一直挂着，UI 表现为「停不下来」。（内核 abort 是否等待在途工具：未证实。）
- 改法：`spawnSubagent(opts & { signal?: AbortSignal })`；`createTaskTool` 传入 signal；`runSubagent` 里 `if (signal?.aborted) throw`，`signal.addEventListener("abort", () => agent.abort(), { once: true })`，finally 里摘监听。web_fetch 用 `AbortSignal.any([signal, AbortSignal.timeout(30_000)])`。MCP：`McpConnection.callTool(name, args, signal)`，abort 时 reject 并发 `notifications/cancelled`（stdio/SSE）或 abort fetch（HTTP）。
- 工时：3h　风险：低-中（需确认内核 `Agent.abort()` 可重入）
- 验收：`agent-retry.loop.test.ts` 同款假 streamFn：子智能体第 1 步后触发父 abort，断言子 agent 不再发第 2 次请求、工具结果为「已停止」；MCP 假服务器挂住 tools/call，abort 后 100ms 内返回。

## 5. bash 子进程生命周期的四个缺口：升级重试路径无超时无取消、原定时器未清、应用退出不回收、Windows 杀不全

- 类别：可靠性
- 证据：
  - 跳过沙箱重试：`src/bun/agent-tools.ts:852-864` 新起的 `retried` 没有 timer、不接 signal、`env: process.env`（858）不带 `augmentPath()`；`killGroup`（811-815）只认第一个 `proc`
  - 原 timer 在 `finally`（879-881）才清，而 847-849 的 `await ctx.escalateSandbox(...)` 要等用户点击（时长不定）
  - `src/bun/runtimes/proc.ts:87-106` 直接 `process.kill(-pid)`，不判断进程是否已退出；win32 上负 pid 无效，退回只杀直接子进程（101-105）
  - `src/bun/shutdown.ts:34-74` 收尾清单里没有 agent 的 bash 进程组，也没有 MCP stdio 连接；而 bash 是 `detached: true`（agent-tools.ts:807），不随父进程退出
- 机制：① 用户批准跳过沙箱后，若命令挂住（dev server、等输入），工具永久不返回，按停止也只会去杀早已退出的第一个进程 —— 正是 890-896 注释里要避免的「一直在执行中」；② 用户思考超过 120s 时旧 timer 触发，对已退出进程的 pgid 发 SIGKILL，pgid 被复用时会误杀无关进程组（概率低、后果重）；③ 应用退出/升级时正在跑的命令成为孤儿（shutdown.ts 头注释 7-12 已经为推理服务器踩过同一个坑）；④ Windows 上超时/停止只杀到 shell，子进程树存活。
- 改法：抽 `runShellCommand(argv, { cwd, env, timeoutMs, signal }): Promise<{ stdout, stderr, exitCode, killed }>`，两条路径共用；`proc.exited.then(() => clearTimeout(timer))`；模块级 `activeShellProcs: Set<Subprocess>`，导出 `killAllAgentShells()` 并挂进 `teardownServices` / `teardownServicesSync`；`killProcessTree` 在 win32 走 `taskkill /pid <pid> /T /F`，并在 `proc.exitCode !== null` 时直接返回。
- 工时：4h　风险：中（动到公共的 proc.ts，需回归推理服务器的停服路径）
- 验收：bash 测试加两条：escalateSandbox 桩返回 null + 命令 `sleep 30`，`commandTimeoutMs=500` 下 1s 内返回且带超时说明；同场景 abort 后 1s 内返回。`killAllAgentShells()` 后 `pgrep -g <pgid>` 为空。

## 6. hooks：prompt 一大，`OMNI_HOOK_PAYLOAD` 环境变量触发 E2BIG，全部钩子「启动失败」并按 fail-open 放行 —— 用来拦截的钩子会被大输入绕过

- 类别：安全 / 可靠性
- 证据：`src/bun/agent-hooks.ts:141-150`（整份 payload 序列化后塞进 env）；160-161 把 spawn 异常归为「启动失败」且 `blocked: false`；设计约定「失败不阻断」（18-19）；调用点 `src/bun/agent.ts:2728-2734` 把用户 prompt 全文放进 payload
- 实测：bun 下 `Bun.spawn({ env: { BIG: "x".repeat(200000) } })` → `E2BIG: argument list too long, posix_spawn '/bin/sh'`（Linux 单个 env 串上限 128KiB；中文 3 字节/字，约 4 万字即触发）。
- 机制：stdin 才是主通道（157-159），env 里那份只是便利副本，却让整条 hook 在大输入时必然起不来；`user_prompt_submit` 的 `decision: block` 因此失效，注入上下文的钩子静默缺席，界面只有一行「失败 N 条」。
- 同文件另两点：`runHook` 不收 AbortSignal，多条钩子串行（286-288）、单条上限 60s（109），期间按停止无效；stdout 用 `new Response(proc.stdout).text()`（189-192）整读无上限，且不像 bash 那样有「子进程退出即收工」的保护，钩子里 `setsid` 出去的后台进程会让它等不到 EOF（未证实：取决于钩子写法）。
- 改法：env 副本设上限（如 >32KB 时只放去掉 `prompt` 的精简 payload，另加 `OMNI_HOOK_PAYLOAD_TRUNCATED=1`）；`runHook(hook, payload, signal)` 接入停止；stdout 复用 `readOutputBounded` 并加字节上限（`MAX_CONTEXT_PER_HOOK` 的若干倍即可）。可选：给 hook 配置加 `failClosed: true`，让守门型钩子在异常时拦下而不是放行。
- 工时：1.5h　风险：低
- 验收：hooks 测试加一条 300KB prompt：钩子正常执行、stdin 拿到完整 prompt、`block` 生效；abort 后 runHooks 在 HOOK_KILL_GRACE_MS 内返回。

## 7. bash 输出在读取阶段没有内存上限；进入模型的截断只保留头部，构建/测试的关键信息恰在尾部

- 类别：性能 / 可靠性 / 体验
- 证据：`src/bun/agent-tools.ts:905-911`（`text += decoder.decode(...)` 无上限）；所谓「内存防呆」`capToolResultText` 在全部读完之后才执行（`agent-tools.ts:294-296`、`src/bun/agent-spill.ts:162-169`）；展示层 `truncateForModel` 取 `text.slice(0, max)`（`agent-spill.ts:177-198`，上限 24_000 字符，24 行）；转存也只留前 2M（`agent-spill.ts:145`）
- 机制：286-292 的注释承诺「一条 `yes` 不会拖垮主进程」，但 120s 内 stdout/stderr 两路字符串会无限增长，峰值出现在裁剪之前 —— 这是桌面应用的主进程，OOM 即整个应用崩溃。另一面，`bun test`/`cargo build` 的失败摘要在末尾，模型拿到的是开头 24k 的编译噪声，必须再花一次 read_file 去翻转存文件。stdout 与 stderr 还是先后拼接（827），交错顺序丢失。
- 改法：`readOutputBounded(stream, exited, { maxBytes })`：保留头部 N + 环形尾部 M（各 ~1MB）并统计丢弃字节；总量超过硬上限（如 64MB）时 `killGroup("output-limit")`。`truncateForModel` 增加 `strategy: "head" | "head-tail"`，bash 走 head-tail（如 8k + 16k，中间写明省略了多少、原文路径）。stdout/stderr 改为共用一个按到达顺序追加的缓冲。
- 工时：3h　风险：低
- 验收：测试 `yes | head -c 300000000`：工具返回、结果含「输出过大」说明、进程 RSS 增量 < 50MB（`process.memoryUsage()` 前后对比）；head-tail 单测断言末尾 200 字符一定出现在模型文本里。

## 8. 产物预览：`other` 类型被当文本整读，无大小上限；被删除的文件也登记成产物

- 类别：性能 / 可靠性
- 证据：`src/bun/agent-artifacts.ts:240`（`TEXTUAL` 含 `"other"`）、273-286（`readFileSync(absPath, "utf8")` 后才按 400_000 字符截）；64MB 保护只在二进制分支（290-293）；`src/bun/agent-tools.ts:629` 对 `result.changes` 全量 `recordArtifact`，包含 `kind: "delete"`（`src/bun/apply-patch.ts:423-426`）
- 机制：扩展名不在 `EXT_KINDS` 的文件（`.safetensors`、`.gguf`、`.zip`、`.sqlite`、无扩展名的大日志）归为 `other` → 走文本分支 → 点一下预览就把数 GB 文件同步读进主进程再转成 UTF-16 字符串。这个应用的工作区里恰恰常有模型与媒体大文件。`readWorkspaceFile`（377-385）走同一条路。另外 `apply_patch` 的 Delete File 会在面板里留下一条 size 为 null、点开即 ENOENT 的「产物」。
- 改法：`readArtifact` 先看 `size`：文本分支超过 `maxChars * 4` 字节时用 `openSync/readSync` 只读前缀；前 8KB 含 NUL 则按二进制处理（返回 `text: null`）；`other` 默认不进 `TEXTUAL`，改为「嗅探为文本才预览」。二进制分支的 64MB data URL 经 RPC 传输同样偏重，建议降到 ~16MB 或改走本地文件协议（未证实：未读 RPC 层）。`agent-tools.ts:629` 过滤 `change.kind !== "delete"`，删除时顺手 `deleteArtifact` 同路径旧记录。
- 工时：1.5h　风险：低
- 验收：单测：稀疏 1GB `.bin`（`truncateSync`）上 `readArtifact` 耗时 < 50ms、返回 `text: null`；补丁删除文件后 `listArtifacts` 不含该路径。

## 9. bash 超时写死 120s，模型与用户都调不了；执行期间没有任何流式输出

- 类别：体验 / 可靠性
- 证据：`src/bun/agent-tools.ts:141`（`COMMAND_TIMEOUT_MS = 120_000`）、769-771（schema 只有 `command`）、784（只读 `ctx.commandTimeoutMs`）；`src/bun/agent.ts:873-934` 组装 ctx 时没有设置 `commandTimeoutMs`（全仓非测试代码里该字段只在 agent-tools.ts:69/784 出现）；`execute` 收了 `onUpdate`（类型在 104-111）但 bash 没用
- 机制：`npm install`、`cargo build`、完整测试套件、拉模型动辄超过 2 分钟，到点整组 SIGKILL，模型只能重跑同一条命令再被杀一次（还会撞上 doom_loop 询问）。工具描述只说「Long-running … not suitable」（768），没告诉模型上限是多少、超了怎么办。执行中界面只有「运行中」，用户无法判断是卡死还是在编译。
- 改法：schema 加 `timeout_ms?: number`（描述写明默认 120s、上限如 30min，超限钳制）；新增设置 `AGENT_COMMAND_TIMEOUT_MS` 作为默认值并在 `toolsForMode` 注入；描述补一句「超过上限的命令用 `nohup … > log 2>&1 &` 放后台，再轮询日志」（`readOutputBounded` 已保证这种写法立即返回）。`readOutputBounded` 的 pump 里按 ~500ms 节流调用 `onUpdate({ content: [{ type: "text", text: tail }] })`，UI 即可显示滚动尾部（内核是否把 update 事件转给订阅者：未证实，agent.ts 的订阅里目前没有处理 update 类事件）。
- 工时：3h（不含 UI 展示）　风险：低
- 验收：`timeout_ms: 1000` + `sleep 5` 在 ~1s 返回超时说明；不传时仍为默认值；传 10 小时被钳到上限。

## 10. 路径校验全部基于 `path.resolve`，不解软链；工作区内部还整体跳过凭据黑名单

- 类别：安全
- 证据：`src/bun/agent-tools.ts:178-186`（`resolvePath`）、212-214（目标在工作区内直接 return，不查 `SECRET_PATH_PATTERNS`）、265-284（`assertReadable` / `assertWritable`）；`src/bun/permissions.ts:429-433`（`isInsideWorkspace`）；`walkDir` 用 `statSync` 跟随软链（325-331）。对照：`src/bun/agent-spill.ts:63-82` 的 `isSpillPath` 已经按 realpath 判，注释（58-61）写明了同类风险 —— 同一个问题在主路径上没处理
- 问题类别：符号链接导致的工作区边界绕过。工作区内一个指向区外的软链（仓库自带，或由 bash 创建）在字面路径上「位于工作区内」，于是三道防线同时失效：区外读取授权（permissions.ts:626-629 直接 return null）、凭据黑名单、以及写操作的区内限制。read_file 等工具跑在主进程里，不受命令沙箱约束，所以即便开了沙箱、bash 读不到的凭据目录，也能经由工具层读到。另外用户把工作区选成 `$HOME` 时，212-214 让 `~/.ssh` 等全部放行（设计取舍「工作区内不受限」在这个配置下过宽）。
- 改法：新增 `realTarget(p)`：对「最深的已存在祖先」做 `realpathSync` 再拼回剩余段（写新文件时目标尚不存在）；`resolvePath` 返回 `{ display, real }`，`assertNotSecret` / `assertReadable` / `assertWritable` 与 `permissionRequestForTool` 统一用 real；`walkDir` 改用 `lstatSync`，软链目录不下钻、软链文件按 real 路径过一遍 `assertReadable`。凭据黑名单改为「即使在工作区内也拒绝」，只对用户显式授权的例外放行。工作区根本身也取一次 realpath（macOS `/tmp` → `/private/tmp`）。
- 工时：3h　风险：中（macOS 上 /var、/tmp 的软链要回归；有人可能依赖区内软链指向 monorepo 外的共享包 —— 此时应走授权而不是静默放行）
- 验收：单测：工作区内建软链指向区外文件，read_file / write_file / grep 均被拒或转为 external_directory 请求；工作区设为假 HOME 时读 `.ssh/x` 被拒；macOS 上 `/tmp/ws` 工作区读写正常。

## 11. 工作区外授权的范围比卡片上展示的大：读一个文件 → 整个父目录递归可读可写；「本会话总是」也会写进全局永久白名单

- 类别：安全
- 证据：
  - `src/bun/permissions.ts:639-645`：区外**读**的 `always` 是 `[dirname, dirname + "/*"]`；`*` 译成 `.*` 且带 `s` 标志（111-120），跨 `/` 递归匹配
  - 读写共用同一个权限名 `external_directory`（读 640、写 592-598、补丁 570-576），规则层不区分读写
  - `request_permissions` 的 `always` 取的是目标的 **父目录**（619），卡片上展示的却是目标本身（616）
  - `src/bun/agent-interactions.ts:212-225`：`reply === "session"` 与 `"workspace"` 走同一分支，都调用 `addAuthorizedFolder`；后者写全局设置 `AGENT_AUTHORIZED_FOLDERS`（`permissions.ts:778-783`），不随会话结束失效
  - 该设置被所有会话的路径层读取（`src/bun/agent-tools.ts:237-249`），并作为沙箱可写根传入（791）
- 机制：用户为「读 `~/notes.md`」点了「本会话总是」，实际效果是：`~` 整棵目录树（凭据黑名单除外）对该会话的工具可读**可写**；`~` 被永久加入全局白名单，此后**任意工作区**的沙箱里 bash 都能写 `~`（沙箱层不经过规则层，没有二次询问）。用户看到的文案与实际授权范围相差两级（文件 → 目录树；本会话 → 永久全局）。
- 改法：① 拆成 `external_read` / `external_write` 两个权限名（或给规则加 `access` 字段），`assertWritable` 只认写授权；② 读文件的 `always` 默认只给该文件，卡片上另给「允许整个目录 `<dir>`」的显式选项，并把最终会写入的 pattern 原样展示；`request_permissions` 目标是目录时用目标本身而非 dirname；③ `session` 回复不落 `AGENT_AUTHORIZED_FOLDERS`，改放进会话内存态并经 `ToolContext.authorizedFolders`（字段已存在，agent-tools.ts:46-50）注入；`workspace` 回复按工作区存（`agent_permissions` 已有 scope/scopeRef），不要进全局设置；④ 顶层目录（`/`、`$HOME`）作为 always 目标时强制降级为「仅本次」。
- 工时：4h（含设置页迁移：已有白名单保留，但标注来源）　风险：中（授权弹窗会变多，需要 UI 配合）
- 验收：permissions 单测：读 `/a/b/c.md` 选 session 后，`write_file /a/b/x` 仍触发询问、`read_file /a/b/sub/y` 触发询问；另一会话不继承；`AGENT_AUTHORIZED_FOLDERS` 未被改写。

## 12. 沙箱不可用时静默 fail-open；「沙箱是否生效」在三处各算一遍且互相不一致；两份凭据清单已经漂移

- 类别：安全 / 可维护性
- 证据：
  - fail-open：`src/bun/agent-sandbox.ts:602-624`、632、641-647 均返回未包装的命令；调用方 `src/bun/agent-tools.ts:793` 只写一条日志就照常执行，工具结果里没有任何提示；会话状态上报的是**配置值** `sandboxMode()`（`src/bun/agent.ts:1083`）而不是生效值
  - 不一致：`agent-tools.ts:838` 用 `sandboxActive()`（`agent-sandbox.ts:777-779`，只看「模式非 off 且平台有任一后端」），而不是本次调用的 `wrapped.backend`。Landlock canary 失败且无 bwrap 时（632）命令实际未沙箱，`sandboxActive()` 仍为 true，输出里出现 `operation not permitted` 就会弹「跳过沙箱重试」
  - 清单漂移：工具层 `SECRET_PATH_PATTERNS` 有 `.docker/config.json`、`.config/(gh|gcloud|gcloud-legacy)`（`agent-tools.ts:200`、204），沙箱层 `sandboxCredentialPaths()` 没有（`agent-sandbox.ts:406-419`），注释却写「同一批意图」（403-404）
  - 平台覆盖：darwin→Seatbelt、linux→bwrap/Landlock、其它（含 win32）→none（69-73）；默认 off（50-53）；默认放行网络（56-58）
- 机制：用户选了 `read-only` 或 `workspace-write`，在 Windows、无 user namespace 的容器、没装 bwrap 也没 C 编译器的 Linux 上，命令以完整权限执行，界面仍显示所选模式。对「我特意开了只读」的用户，这是最危险的一种失败方式。
- 已知逃逸面（只列类别）：Seatbelt 的 workspace-write+联网档用 `(allow default)`（547-553），未限制 mach 服务 / Apple Events / LaunchServices 这类「委托沙箱外进程代办」的通道；三档都整体放行 `/tmp`、`/var/folders`（482-484），只读档下位于 `/tmp` 的工作区实际可写；Landlock 后端无法挡凭据目录的读（代码已在 299-301 如实声明）；环境变量原样传入沙箱（`agent-tools.ts:808`），启动环境里的 `*_API_KEY` / `*_TOKEN` 不在「凭据目录挖空」的保护范围内。
- 改法：`WrappedCommand` 增加 `enforced: boolean`；`read-only` 档降级时 **fail-closed**（直接 errorResult，说明原因与安装指引），`workspace-write` 档保留执行但在工具结果首行加 `[沙箱未生效：<原因>]`，并经 `escalateSandbox` 同款通道让用户确认一次；838 改用 `wrapped.backend !== "none"`；`describeAgentSession` 增加 `sandboxEnforced` / `sandboxBackend`。凭据清单抽到一个共享模块（如 `credential-paths.ts`），同时导出正则形式与绝对路径形式，由同一份数据生成。Seatbelt 默认档建议收紧为 `deny default` + 显式 allow（已有禁网档的写法可复用）。可选：沙箱开启时对 env 做 `*_KEY|*_TOKEN|*_SECRET|*PASSWORD*` 过滤，设置里给白名单。
- 工时：3h（不含 Seatbelt 策略收紧；那部分另计 4h 且需真机回归）　风险：中
- 验收：单测：`platform: "win32"` + `read-only` → 工具返回错误且未 spawn；`landlockCanaryReady: false, bwrapReady: false` 时结果不含「跳过沙箱」提示；新增快照测试断言两份凭据清单来自同一数据源。

## 13. MCP 连接生命周期：断了不重连、失败不缓存、并发连接泄漏子进程、初始化不快速失败、重名兜底可能死循环

- 类别：可靠性
- 证据（均在 `src/bun/mcp.ts`）：
  - 不重连：execute 发现 `!cached.conn.alive` 直接报错（807-811）；而工具集随会话跨回合复用（`src/bun/agent.ts:864-866` 注释），重连只发生在下次 `toolsForMode`。`HttpConnection.alive` 恒为 true（470-472），服务端会话过期后每次调用都失败且永不重新 initialize
  - 失败不缓存：`connectEnabledServers` 只在成功时 `connections.set`（742），坏掉的服务器在每次建会话（`agent.ts:954`、2196）和每次打开工具列表（`agent.ts:1089-1090`）时都重试，单次最长 `INIT_TIMEOUT_MS` 20s + `LIST_TIMEOUT_MS` 30s（28-29），直接加在首条消息的延迟上
  - 并发泄漏：727-749 没有 in-flight 去重；两个调用方同时未命中缓存会各起一个 stdio 子进程，后写入者覆盖 Map，先起的那个永远没人 `close()`
  - 不快速失败：stdio 进程启动即退出时无人监听 `proc.exited`（295-317），initialize 傻等 20s；stderr 被直接丢弃（303，注释却说「丢给控制台便于排查」），最终错误只有一句 `timed out`
  - 死循环：`while (usedNames.has(name)) name = \`${name}_x\`.slice(0, 64)`（798）在 name 已满 64 字符时不变，主进程自旋卡死；`toolId` 会截到 64（715-718），同一服务器两个超长同前缀工具名、或两个 slug 相同的服务器（非 ASCII 名称全被替换成 `_`，711-713）带同名长工具即可触发
  - 子进程清理：`close()` 只 `proc.kill()` 单进程 SIGTERM（364-373），未 `detached`、无 SIGKILL 升级；`npx`/`uvx` 启动器下真实服务器可能残留（未证实：取决于启动器是否转发信号）；应用退出路径不关 MCP（`src/bun/shutdown.ts:34-74`）
  - 其它：`requestRaw` 的超时 timer 成功后不清、超时后不 abort fetch（428-443）；用户在服务器 env 里配置的 `PATH` 被 `augmentPath()` 覆盖（299 的展开顺序）；不处理 `tools/list` 分页与 `notifications/tools/list_changed`（141 丢弃所有通知、340-348）；图片结果被替换成字面量 `[image]`（203），视觉模型拿不到；stdio 行缓冲无上限（274-285）
- 已处理好的部分：大结果经 `afterToolCall` 统一截断转存（`agent.ts:642-661`）；工具名加 `mcp_<slug>_` 前缀，不会与内置工具重名（715-718）；注入类 env 键被拦（236-262）
- 改法：`ensureConnected(serverId): Promise<CachedConnection>`，内部用 `Map<number, Promise<…>>` 做 in-flight 去重，execute 在 `!alive` 时调用它并重试一次；失败结果带 `failedAt` 负缓存 60s（设置页「测试连接」强制刷新）；stdio `connect()` 里 `Promise.race([initialize, proc.exited.then(code => { throw new Error(\`exited ${code}: ${stderrTail}\`) })])`，stderr 保留最后 2KB；重名兜底改为「截到 60 + `_` + 3 位序号」；`close()` 走 `killProcessTree` + 2s 后 SIGKILL，并导出 `closeAllMcpConnections()` 挂进 shutdown；env 展开改为 `{ ...process.env, PATH: augmentPath(), ...env }`。
- 工时：6h　风险：中
- 验收：新增 `mcp.test.ts`（目前该文件没有任何测试）：假 stdio 服务器脚本覆盖「启动即退出 → 1s 内报错且带 stderr」「调用中被 kill → 下一次调用自动重连成功」「并发两次 connect → 只 spawn 一次」「两个 64 字符同名工具 → 不挂死且名字唯一」。

## 14. grep / glob / read_file 全是同步全量 I/O，跑在桌面应用主进程里；无大小与二进制防护；read_file 在 60k 处静默截断

- 类别：性能 / 体验
- 证据：`src/bun/agent-tools.ts:311-339`（`walkDir`：`readdirSync` + 逐项 `statSync`，先收集全量再过滤）；482-502（grep 对每个文件 `readFileSync(file, "utf8")`，无大小上限、无二进制判断；`utf8` 解码不会对二进制抛错，496 的注释不成立）；488（`globToRegExp(params.include!)` 在文件循环里反复编译）；381-389（read_file 整文件读入后才按 offset/limit 切，389 的 `slice(0, MAX_FILE_CHARS)` 不带任何截断提示）；这几个 execute 都不接 signal
- 机制：OmniStudio 的工作区常含生成的视频、音频、模型权重；一次 `grep pattern .` 会把它们逐个完整读进内存并转成字符串，期间主进程事件循环完全阻塞 —— RPC、其它会话的流式输出、MCP 读循环、乃至「停止」按钮都得不到处理。模型给的正则还可能灾难性回溯（477），同样无超时。read_file 对大于 60k 字符的文件只返回前缀且不说明，随后 `afterToolCall` 再截到 24k 并声称「完整输出已存到…」—— 转存的其实也只是前 60k，模型会把它当成文件全貌。
- 改法：grep 优先走 `Bun.which("rg")`：`rg -n --no-heading --max-count 200 --max-filesize 2M -e <pattern> [-g include]`，用第 5 条抽出的 `runShellCommand` 获得超时与取消；没有 rg 时退回现实现，但改为异步遍历（`fs.promises` + 每 N 个文件 `await` 让出一次 + 检查 signal）、跳过 >2MB 与含 NUL 的文件、遍历总数设上限并在结果里注明「已跳过 N 个大文件/二进制」。read_file：`statSync` 超过阈值（如 10MB）且未给 limit 时只读前 N 行并返回 `[共 M 行，已显示 1-N；用 offset=N+1 继续]`；任何截断都在末尾写明下一段的 offset。list_dir 隐藏 dot 文件（412）同理应加一行「已隐藏 K 个 dot 项」；其 schema 把 `path` 标为必填（404）却在描述里说有默认值，应改为 Optional。
- 工时：6h　风险：中（rg 与内置实现的正则方言差异，需在描述里说明）
- 验收：基准：含一个 1GB 稀疏文件 + 5 万个小文件的目录上 grep，主线程最长阻塞 < 50ms（`setInterval` 抖动探针），总耗时下降；read_file 读 10 万行文件时输出含明确的分页提示；abort 后 200ms 内返回。

## 15. bash 权限规则按「整条命令串」通配匹配：任何带通配的 allow 规则都会放行其后拼接的复合命令；危险命令清单覆盖窄，而更完整的正则版是死代码

- 类别：安全
- 证据：`src/bun/permissions.ts:111-120`（`*` → `.*`，末尾「 *」可省）；196-207（后匹配覆盖先匹配）；399-406（用户/工作区/会话规则排在内置规则之后）；smart 模式的危险项是内置层的 `ask`（292-301、308-336）；正则版 `DANGEROUS_COMMAND_PATTERNS`（87-105）只被 `isDangerousCommand`（442-446）使用，而后者在非测试代码中**没有任何调用方**（全仓仅 `permissions.test.ts` 引用）
- 回答任务里的问题：规则匹配不是「前缀匹配」而是整串通配，界面生成的「始终允许」是**精确命令**（537-544 的 `always: [rulePattern]`），不可被拼接绕过；但用户在设置页手写的 `git *`、`npm run *` 这类规则（`permissions.ts:108-110` 与 `src/bun/db/schema.ts:908` 的注释都把「末尾 ` *` 可省」当作推荐写法）会匹配 `git status && <任意命令>`，并且因为优先级更高，还会**盖掉**内置的危险命令询问。`;`、`&&`、`||`、管道、`$(…)`、反引号、换行都没有被切分。已做的归一化（142-193）只解决空白与引号等价写法。
- 清单问题：通配清单大小写敏感、只认固定写法，选项拆分/长选项/大写选项等等价形式不命中；正则版更全（大小写不敏感，多出 `kill -9`、`halt`、写块设备、fork bomb 等）却没接入求值。两份清单并存本身就是漂移源。
- 体验侧的连带问题：精确匹配的「始终允许」几乎不会再次命中（参数一变就重新问），manual 模式下审批疲劳会把用户推向 auto。
- 改法：新增 `splitCompoundCommand(cmd): string[]`（复用 `canonicalCommand` 的引号状态机，在未加引号的 `; && || | & \n` 处切分，`$(`、反引号、`<(` 出现即标记为「不可静态判定」）；`evaluate` 对 bash 改为逐段求值取最严（deny > ask > allow），不可静态判定的整条按 ask；危险判定统一成一份数据（保留通配形式给设置页展示，求值时额外跑正则版，二者取并集）。在此基础上，授权卡片可以安全地提供「始终允许 `<首词 + 子命令> *`」这一档。
- 工时：6h　风险：中（询问次数会上升，需要观察误报）
- 验收：permissions 单测：规则 `git *`→allow 下，`git status` 放行、`git status && rm -r x` 为 ask、`echo $(…)` 为 ask；`isDangerousCommand` 的现有用例全部改为经 `evaluate` 断言。

---

## 次要项（不计入上面 15 条，供顺手处理）

- **web_fetch**（安全/可靠性，3h）：`src/bun/agent-tools.ts:1258-1275` 不限制回环/私网/链路本地地址，`redirect: "follow"`（1268）可经跳转到达内网；`res.text()`（1273）无响应体上限；30s timer 在拿到响应头后就清掉（1270），慢速响应体不受超时约束；而 `webfetch *` 在四种审批模式（含 strict）下都是 allow（`src/bun/permissions.ts:239`）。建议：解析后按 IP 段拦截（含重定向逐跳校验）、流式读取并限 2–5MB、超时覆盖整个 body、strict 模式下 webfetch 默认 ask。
- **CRLF 与重复段**（可靠性，3h）：edit_file 按原样比较（`agent-tools.ts:558-560`），CRLF 文件配 LF 的 old_str 会得到误导性的「文件被改过」提示（124-126）；apply_patch 只归一化补丁文本（`src/bun/apply-patch.ts:78`），目标文件按 `\n` 切（364）后行尾带 `\r`，靠 `trimEnd` 级匹配命中，新增行不带 `\r` → 写出混合换行。同一补丁里对同一文件写两个 `*** Update File` 段时，第二段基于磁盘原文计算（404-438 无内存覆盖层），落盘时覆盖第一段的结果且不报错。建议：检测文件主导 EOL 并应用到新增行；`applyPatch` 内加 `Map<path, contents>` 覆盖层。
- **PATH 拼接**（可靠性，1h）：`agent-tools.ts:928-942` 与 `mcp.ts:215-229` 用 `":"` 连接，Windows 上会把 POSIX 目录串与原 PATH 的第一项粘成一个无效条目（未证实：无 Windows 环境；shell.ts 明确支持 win32）；`~/.nvm/versions/node/*/bin` 是字面量星号，PATH 不展开通配，该条目永远无效。应使用 `path.delimiter`、win32 跳过 POSIX 目录、nvm 目录用 `readdirSync` 取最新版本。
- **工具并行**（可靠性，0.5h，未证实）：`src/bun/media-tools.ts:576/694/867/963` 显式标了 `executionMode: "sequential"`，推测内核默认并行；`agent-tools.ts` 里的 bash / write_file / edit_file / apply_patch 都没标。若默认确为并行，同一轮里的 `git add` 与 `git commit` 会并发执行。建议给有副作用的工具统一标 sequential。
- **Landlock 探测时机**（性能，0.5h）：`agent-sandbox.ts:94-95` 在 bwrap 可用时仍会同步求值 `landlockHelper()`（首次会 `spawnSync` 编译 C 辅助程序，单个编译器超时 30s），应改为惰性求值。
- **测试缺口**：`read_file` / `list_dir` / `glob` / `grep` / `write_file` / `edit_file` / `web_fetch` 没有任何单测；`mcp.ts` 没有测试文件；bwrap 只有 argv 级断言、没有真实执行的端到端（Seatbelt 有，`agent-sandbox.test.ts:537` 起）；hooks 没有大负载用例。第 1、2、3、6 条都属于「有一条最小用例就能拦住」的缺陷。

## 看起来像问题、但代码已经处理好的 3 点

1. **apply_patch 的原子性**：匹配阶段全部在内存里完成（`src/bun/apply-patch.ts:401-442`），落盘阶段逐笔记录 undo，失败时倒序回滚并如实说明回滚是否完整（444-484）。不必再建议「加事务」。
2. **bash 被后台进程占住 stdout 导致永久挂起 / 超时只杀 shell 留下孤儿**：`readOutputBounded` 以「直接子进程退出 + 200ms 宽限」为结束条件而不是管道 EOF（`src/bun/agent-tools.ts:898-922`），`detached` + `killProcessTree(-pid, SIGKILL)` 整组终止并在结果里说明原因（802-833），`stdin: "ignore"` 防等输入；三种情形都有测试（`agent-tools.bash.test.ts:28-62`）。缺口只在第 5 条列的旁路上。
3. **转存目录的软链绕过 / 命令等价写法绕过规则 / 钩子来源**：`isSpillPath` 按 realpath 判定，堵住了「在 tool-output 下建软链读凭据」（`src/bun/agent-spill.ts:63-82`）；bash 规则匹配前做引号与空白归一化，多一个空格或加引号绕不过去（`src/bun/permissions.ts:142-193`、418-421）；hooks 只读应用设置、绝不读工作区配置，超时后 SIGTERM→SIGKILL 升级不会卡死回合（`src/bun/agent-hooks.ts:23-25`、167-186）；`request_permissions` 必经授权闸门，不会凭空返回「已授权」（`permissions.ts:608-621`）。
