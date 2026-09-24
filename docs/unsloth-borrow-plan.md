# Unsloth Studio → OmniStudio 可借鉴清单

> 调研日期：2026-09-22 ｜ 调研对象：`/home/xixi/unsloth-dev/studio`（Unsloth Studio，Python + Tauri）
>
> **许可证前提（硬约束）**：Unsloth Studio 的 `studio/` 目录是 **AGPL-3.0-only**（每个源文件带 SPDX 头），
> OmniStudio 是 **MIT**。因此**只借鉴行为、算法与设计决策，用 TypeScript 自行实现，禁止复制其源码或注释文字**。
> 下文的公式与常数视为功能性事实，实现表达一律重写。
>
> **证据强度说明**：Unsloth 侧的 file:line 均为一手实读；OmniStudio 侧凡标注「待核实」的，
> 是调研 agent 因 worktree 守卫拦截 Bash 而未能验证的推断，**落地前必须先在本仓库 grep 复核**。

---

## A. 已在实施（本分支的主线任务）

**自动启动参数规划**（自动上下文长度 / 自动加速策略 / 自动启动参数）——见 `docs/auto-launch-params.md`（随实现产出）。
对应 Unsloth 的 `core/inference/llama_cpp.py::load_model`。本清单不重复该部分。

---

## 落地进度（2026-09-22）

| 条目 | 状态 | 产物 |
|---|---|---|
| B1 安装完整性 manifest | ✅ 已落地 | `bun/install-manifest.ts` + 接进 `engine-install.ts` 两条安装路径；`engine-catalog` 加 `installComplete` / `installIssue`（只对托管安装判定，PATH/brew/系统安装不受影响）。这一版只记录不阻断 |
| B2 下载 manifest + cancel marker | ✅ 已落地 | `bun/download-manifest.ts`（存储层，15 测试）+ 接进 `download-manager.ts`：开始下载写 manifest 并清取消标记、完成后 `checkAgainstDisk` 比对（不完整只记 `download.manifest.incomplete`，不改任务状态）、取消打标记。文件清单由 `startModelDownload` 的 `manifestFiles` 从前端带下来 |
| B3 tool-call healing | ✅ 解析层已落地 | `shared/tool-call-healing.ts`：hermes / function-tag / bracket-tool-calls / gemma 四种格式，15 测试 + 一份病态输入验收脚本。接进 agent 响应处理的那一步待做 |
| B4 子进程孤儿回收 | ✅ 已落地 | `bun/child-registry.ts` + `bun/index.ts:193` 启动扫尾 + `proc.ts` 三处维护记录 |
| 其余条目 | 未开始 | 见下文 |

**B4 的一条加固待办**：身份核对目前只比对 cmdline 里的 basename，`exe` 是 `python` 这类常见名时
（vLLM / SGLang 就是），pid 被系统复用后理论上仍有误杀余地。加固方案是记录时一并存
`/proc/<pid>/stat` 的 starttime 再比对（macOS 用 `ps -o lstart=`），可把风险清零。

---

## B. 建议优先落地（高价值）

### B1. 安装完整性 manifest —— 「装完了」必须是一个可验证的事实

- **问题**：安装器被中途杀掉后，venv / 引擎目录看起来是好的（`-h` 能答），实际缺依赖，直到运行时才炸。
- **Unsloth 做法**（`studio/install_manifest.py`，仅 376 行、零依赖）：
  manifest **在依赖安装开始前先删掉，最后一步才写回**——「它存在」等价于「安装完成」。
  内容含 schema 版本、完成时间、包版本、python 版本、platform、prefix、步骤总数、每个 requirements 文件的 sha256。
  `verify_install` 返回稳定的 reason 字符串（incomplete / schema / version_changed / requirements_changed / deps_missing），直接透传给用户。
  两个精妙补充：① 另加一个在依赖 pass **之前**写、能活过 pass 的标记文件，用于回答「死在 pass 中途」的情形，
  且该标记返回三态（true/false/**unknown**），unknown 时调用方必须回退到自己的探测而非当 false；
  ② 删除 manifest 失败要返回 false（Windows 上被锁），残留的 manifest 会让后续被杀的 pass 误验证成「完成」。
- **OmniStudio 现状（已核实）**：引擎目录有 state/version/path/disk usage（`shared/local-engines.ts` +
  `bun/engine-catalog.ts`），`bun/engine-install.ts:481` 也已经有 `.staging-<pid>` 临时目录的做法。
  但全仓搜不到 manifest / receipt / 安装完整性校验 —— **「这次安装到底完没完成」目前没有任何 ground truth**。
- **价值：高｜难度：低**（直译约 250 行 TS）。改动点：每个 install adapter 开头 `removeManifest()`、结尾 `writeManifest()`；
  引擎行状态改读 manifest；`verifyInstall` 的 reason 接到 UI。vLLM / SGLang 走 pip 装 venv，正是同一失败模式。

### B2. 下载 manifest + cancel marker —— 「下到一半」必须能被识别

- **问题**：resume 无操作地成功返回 → 被判为下载完成；半个 GGUF 在模型列表里冒充完整模型。
- **Unsloth 做法**（`backend/hub/utils/download_manifest.py`）：
  manifest 记录「这次下载本应取哪些文件 + 每个文件 HF 声明的大小」，两个消费者（下载 worker 比对磁盘实际大小；
  inventory 扫描据此把缺文件/尺寸不足标为 partial）。cancel marker 记录 `(repo_type, repo_id, variant)` 三元组，
  **存在性本身是信号**。三条 I/O 契约：写入一律 `tmp + rename` 原子化；**manifest 读失败 fail-open**（回落磁盘检查，兼容已有缓存导入）；
  **cancel marker 读失败 fail-closed**。manifest 有 schema 版本且新旧共存，migration 带上限。
- **OmniStudio 现状**：**已为此流过血**——AGENTS.md 记录了 `installedFilesForRepo` 必须 repo-scoped 的真机事故
  （全局文件名集合导致「下整个模型」跳过真权重，丢过 K2-Horizon-7B 的 5.0+2.5 GB 与 Qwen3.8-27B-MTP-MLX 的约 16 GB），
  以及 `supportFiles` 要计数、陈旧 failed task 不能阻止缺失文件入队。说明当前靠「扫磁盘 + 文件名比对」判断完整性，**没有 ground truth**。
- **价值：高（全仓最相关）｜难度：中低**。可落成 `<dataDir>/downloads/manifests/*.json` 侧车绕开 migration，
  或进 Drizzle 表。改动点：下载 worker 起止写/删 manifest；`installed-models.ts` 的完整性判断改为「有 manifest 就信 manifest」；
  取消按钮落 marker 而不只是改 task 状态。

### B3. 工具调用文本修复（tool-call healing）

- **问题**：小参数本地模型经常把 tool call 吐成**纯文本**（`<tool_call>{...}`、`<function=...>`、`[TOOL_CALLS]`…），
  透传给 agent 就变成散文，整轮对话废掉。
- **Unsloth 做法**：三层。`tool_call_parser.py` 解析 **14 种**序列化格式（Qwen/Hermes、Qwen3.5 XML、Llama-3 python_tag、
  Mistral 三变体、Gemma 4、DeepSeek R1/V3/V3.1 的 5 种 opener 拼写、GLM 的 arg_key/arg_value、Kimi 的 `functions.NAME:IDX`），
  **缺失闭合标签一律容忍**（模型常截断）；`core/tool_healing.py` 把同一套逻辑抽成零重依赖模块供外部服务单独 import
  （内含一个性能细节：闭合 token 不存在时跳过注定失败的懒扫描，否则一串未闭合 opener 会 O(n²)）；
  `passthrough_healing.py` **只在响应侧**提升回结构化 `tool_calls`，请求体一字不动（保住 KV cache 复用）。
  三条安全不变量：只有请求声明了 client tools 才触发；只提升函数名严格匹配已声明工具的调用；
  提升时精确移除被提升那些调用的 markup span，**未匹配的一个字节都不动，原样透传成文本**——healing 永不静默删输出。
  另有 `tool_choice` 收窄白名单、流式缓冲 64 KiB 封顶。
- **OmniStudio 现状（已核实）**：agent loop 由 `pi-agent-core` + `pi-ai` 驱动，只认结构化 `tool_calls`；
  全仓搜 `<tool_call>` / `<function=` / healing 之类的模式，在 `src/bun/` 下**一处都没有**
  （只有 prompt 种子 JSON 里的无关命中）。确认缺失。
- **价值：高｜难度：中**。全是正则与字符串处理，可直译。建议**只移植 4 种格式**（Qwen/Hermes、`<function=>`、Gemma、Mistral）
  覆盖大多数，配上那三条不变量。改动点：在 pi-ai 的响应处理与流式解析之间插一层。

### B4. 子进程生命周期绑定 —— 父进程异常死亡后不留孤儿

- **问题**：关终端 / End Task / SIGKILL / 崩溃时，协作式关闭路径根本不会跑，推理引擎子进程带着几 GB 显存活下来，下次启动端口被占。
- **Unsloth 做法**（`backend/utils/process_lifetime.py`）：三条平台路径——Windows 用父进程持有的 Job Object
  （`KILL_ON_JOB_CLOSE`，子进程自动继承，父进程 handle 关闭时**由操作系统**回收）；Linux 在 preexec 钩子里设
  `prctl(PR_SET_PDEATHSIG)`（只对直接子进程有效，所以 worker 另外记账）；**macOS 两者都没有，所以受管子进程落盘记录，
  下次启动扫尾回收**——那是 macOS 崩溃/强退后唯一的手段。配套细节：单独记 `start_new_session` 子进程的进程组
  （leader 可能先退，组是抓住它孩子的唯一把手）；记录的读-改-写要加锁（两个线程各自从自己的快照写回会丢 pid）；
  **保障失效必须留痕**（明说「崩溃会留下子进程，下次启动扫尾会回收」）。另有 parent watchdog 以
  `getppid() != parent_pid` 判死（内核事实，免疫 pid 复用，不像 `kill -0` 会把僵尸算成活着）。
- **OmniStudio 现状**：AGENTS.md 有 Hard Rule「子进程 detached 启动、按进程组 `kill(-pid)`」，
  但那只覆盖**优雅关闭**；父进程被 SIGKILL 时无保障，也没有落盘记录 + 启动扫尾。
- **价值：高｜难度：中**（Linux prctl / Windows Job Object 需 `bun:ffi`）。
  **建议先做纯 JS 的那条**：`<dataDir>/child-pids.json` 记录 + 启动时 `reapRecordedChildren()`，
  成本低且正好补上当前空白。OmniStudio 同时管 llama.cpp / vLLM / SGLang / MLX / whisper / OCR 多个吃显存的子进程，孤儿代价最大。

### B5. 按请求 model 名自动切换本地模型 + 空闲 TTL 卸载（llama-swap 式）

- **问题**：外部 OpenAI 兼容客户端（Cursor / Continue / 任意 SDK）发来的 `model` 与本地当前加载的对不上，
  要么 400 要么答非所问；以及模型常驻白占显存。
- **Unsloth 做法**：三个**默认全关**的开关——auto-switch（`/v1` 请求的 model 命中已下载的本地 GGUF 就透明加载，
  **认不出的名字原样放行**）、auto-download（认得出 repo 但没下就后台下载，**必须 gated 在 auto-switch 上**）、
  auto-unload-idle。空闲卸载有 **60 秒地板**（0 仍表示关闭），理由是极小 TTL 会在活跃对话的两轮之间拆掉模型，
  每轮都要重载权重 + 重跑 prefill；另有一个独立的环境变量默认值，不受 auto-switch gate 限制，专供无头部署。
  模型名匹配**刻意保守**：只认已下载且 quant 确实在盘上的名字，**绝不触发意外的几 GB 下载**。
  在途请求保护：中间件按路径前缀+后缀识别推理中请求，保证超过 TTL 的长流不被中途卸载；
  单独记「卡在卸载闸门上、还没进 inflight」的请求数，否则 idle loop 会在它脚下把模型卸了。
- **OmniStudio 现状（已核实）**：**空闲卸载已经有了**（`SERVER_IDLE_UNLOAD_MINUTES` +
  `bun/model-servers.ts` 的 `unloadIdleServers()`），可借鉴的只是那条 60 秒地板的经验；
  **auto-switch 确认没有** —— 全仓搜不到按请求 model 名切换本地模型的逻辑，
  运行模型页仍是手动选引擎与参数。
- **价值：高｜难度：中**。OmniStudio 有 gateway + cloudflared 隧道，明确面向「让外部客户端接进来」，
  正是 model 名对不上的高发场景。**与本分支的自动启动参数强相关**（自动切换要决定新模型用什么参数起），建议一起设计。

### B6. 预编译引擎分发框架（descriptor 驱动 + staging 原子激活）

- **问题**：给任意平台/加速后端下发正确的原生二进制，并做到「下到一半断电也不会留下半个能跑的安装」。
- **Unsloth 做法**（`studio/prebuilt_core.py`）：底层原语（带重试的 HTTP、token-safe 重定向、校验下载、
  安全解包、安装锁、CUDA runtime line 选择）+ 上层**描述符驱动的通用安装流**
  （release 解析 → checksum 索引 → 覆盖度感知的 artifact 选择 → 校验下载 → 解压到 `.staging` → **原子激活** →
  写 marker/fingerprint → resolve 探针）。llama.cpp 与 whisper.cpp 共用，加第三个组件只需一个 descriptor。
  关键常数：HTTP 重试 4 次、基础退避 0.75s、可重试状态码 {408,429,500,502,503,504}、安装锁超时 300s、
  staging 目录名 `.staging`、**首选后端没有覆盖 artifact 时自动退到 CPU**、CUDA 最低 major 12、
  Blackwell 最低 sm 100 / 最低 toolkit 12.8（个别 sm 要 12.9）。
  另有一条工程习惯值得抄：所有可被 mock 的协作者从第一个参数注入，测试无需改模块全局。
- **OmniStudio 现状**：已有 11 个引擎的统一目录与安装/升级/卸载，但
  「CUDA/ROCm 变体矩阵选择 + 覆盖度回退 + staging 原子激活 + checksum 索引」**待核实**。
- **价值：高｜难度：中高**。建议**只移植结构**：descriptor 概念 + staging 原子激活 + marker + CPU 回退，
  CUDA/Blackwell 的 toolkit 常数表可直接采用。Linux 用户的 CUDA 版本千奇百怪，「下载一半激活」是最难查的一类 bug。

### B7. 远程代码静态扫描 + 指纹化同意（trust_remote_code 闸门）

- **问题**：HF/ModelScope 上的模型可以在 `auto_map` 里挂任意 Python，`trust_remote_code=True` 就是直接执行陌生人的代码。
- **Unsloth 做法**：执行前静态扫 repo 的 `modeling_*.py`。定位很清醒——「是提高门槛和知情同意的辅助手段，不是硬边界；
  隔离（子进程/venv）是另一层」。四个关键设计：① **规则集版本化**，规则一改就 bump，旧版本的批准被忽略 → 同样的字节会被重扫重问，
  而不是静默放行；② 扫描覆盖 **5 个 config 文件**（只扫 config.json 会漏掉带自定义 processor 的 VLM）；
  ③ 「有代码但读不到」（离线/gated/404）**抛异常 fail-closed**，「repo 里根本没有 .py」→ 空结果放行——
  把两者混为一谈会既挡住无代码的 repo，又对看不见的代码 fail-open；④ 判决分四档：无 auto_map 放行、
  **CRITICAL（反弹 shell / IMDS / 凭据窃取 / dropper）硬阻断且永不可批准，第一方也不行**（防被攻陷的可信 repo）、
  HIGH/MEDIUM 可由用户批准但**批准 pin 在扫描指纹上**、不可扫 fail-closed。
- **OmniStudio 现状**：安全面只有凭据黑名单、用户路径校验、备份解包路径安全；
  「从 hub 下来的模型可能带可执行代码」这个概念**未见**。
- **价值：高｜难度：中高**。可分两步：先只做「检测到 `auto_map` 就弹窗告知并要求确认」，扫描规则后补。

---

## C. 值得做，但不紧急（中高 / 中）

| # | 条目 | 一句话 | 价值 | 难度 |
|---|---|---|---|---|
| C1 | **API 流量监控** | 进程内 50 条环形缓冲 + 浮动面板。可抄的细节：只对「经 API key 调用」自动弹出（自己的聊天不弹）；**单调时钟锚点**（时长不受 NTP 跳变影响）；**TTFT 要算工具卡片、token 速率的时钟不能算**（工具执行那段不是在解码）；模型加载/卸载也是时间线上的一行；面板开着 1.5s 轮询、关着退到 5s、手动关掉后 60s 安静期才重新武装。 | 中高 | 低 |
| C2 | **本地 Deep Research 持久化 supervisor** | 可持久化的多步研究运行。最值钱的是**自适应上下文预算**：证据上限按已加载上下文算（每 token 约 3 字符、给报告留 4096 token），**每段都有地板**（证据 1500 字符 / 问题 800 字符）——因为小上下文溢出可恢复，**空提示词不可恢复**，裁到 0 会产出自信的空报告；低于 8192 token 上下文就跳过正文抓取只用 snippet。另含**提示注入屏蔽**（网页内容作为不可信数据）与**引用校验**（编造的引用会被拦）。 | 中高 | 中高（**但屏蔽与引用校验可单独拆出来先用在现有 Agent 上，成本低收益高**） |
| C3 | **RAG 本地文件夹同步** | 「把我的笔记目录接进知识库并自动跟随」。关键决定：**周期性 reconciliation 而非事件驱动**（事件会丢、会重复、跨平台语义不一致）——这个选择建议照搬。配套 SQLite 作业租约（30s 租期 / 5s 心跳 / 一条 upsert SQL 表达「自己的可续、别人的过期才能抢」）。 | 中高 | 中 |
| C4 | **单模型分享链接**（签名 capability） | `/p/{ref}/v1/...` 只读 OpenAI 兼容端点，token 从 query 或 Bearer 两处取（同一 capability 同时服务人和机器）。三条安全不变量必须一起搬：任何无效 token 与不存在的 ref 一样返回**通用 404**（永不泄露存在性）；**先验签再读 kill-switch**（避免设置库读放大 + 没有 on/off oracle）；单次输出封顶（公开 bearer 一个调用就能占死串行的 GPU）。 | 中 | 中低 |
| C5 | **MCP 配置一键导入** | 解析 Claude Desktop / Cursor / Cline / VS Code 的 `mcpServers` JSON。核心设计：返回 `(entries, errors)` 而非抛异常，**一条坏条目沉不掉整次导入**；对不支持的字段（变量引用 `${...}`、cwd/envFile、timeout、sandboxEnabled）明确拒绝并给一句人话。 | 中（**性价比极高**） | 极低（169 行纯解析） |
| C6 | **价目表结构** | 数据会过期，**结构才是要点**：缓存倍率作用在 input 基价上而非绝对价；长上下文阶梯价是 `阈值 + 长上下文入价 + 长上下文出价` 三元组；裸 id 与带日期 id 都建表项。 | 中 | 低 |
| C7 | **Agent 出站域名策略** | 域名归一化拒绝：控制字符、`\ / @ ? #`、带 scheme 或端口、**非规范数字 IP**（`0x7f.0.0.1`）、IDNA 失败、超 253 字节。配 DNS pinning 防 rebinding。一个少有人想到的点：**LRU 缓存的 key 会持有原始串直到进程结束，所以只有短到像真域名的才允许进缓存**。 | 中 | 低 |
| C8 | **凭据加密的 AAD 绑定** | AES-GCM 的 additionalData 绑定 `kind + scope`，**密文行不能被调包**（把 provider A 的 key 行搬到 B 上会解密失败）；密钥与密文分库存放。 | 中 | 低（Bun 的 `crypto.subtle` 直接支持 `additionalData`） |
| C9 | **前端：在途生成页常驻挂载** | 图像/视频/音频页不通过路由挂载而是常驻（仍然 lazy），**离开 tab 时在途的批量生成不会被卸载**。OmniStudio 用「主进程 push 直写 store」部分规避了，但页面组件卸载后的本地 UI 状态仍会丢。 | 中 | 低 |
| C10 | **前端：可复用引导巡览** | 一套 `GuidedTour` + controller + 打开事件 + ReadMore，被三处复用——是**机制**而不是三个一次性引导。 | 中 | 低 |
| C11 | **sd.cpp 作为「无 GPU 档」图像后端** | 对外暴露与 diffusers 完全相同的接口，只在没有可用 CUDA/ROCm/XPU 时被选中，首次使用惰性安装，能力不足自动回退。**刻意保持 import 轻量**（不 import torch）。补的是平台覆盖缺口——OmniStudio 的本地图像只有 mflux（仅 Apple Silicon）+ ComfyUI，Linux/Windows 无显卡用户只能走云。 | 中 | 中 |

**C 组里的零散小点**（价值中低，成本极低，可顺手做）：
媒体库 pin/archive 侧车 JSON（fail-safe 分级：只展示的调用方可忽略损坏，**凭 flag 执行删除的必须 fail-closed**）；
coding agent 探测（探测 `claude`/`codex`/`pi` 等哪些在 PATH 上，前端据此默认选一个用户立刻能跑的）；
应用更新检查的 TTL 取值（**成功缓存 12h、失败缓存 1h**，本地安装源不查更新，import 时与健康检查都不做网络）；
bearer 中间件**在原始 header 字节上比较**（对非 ASCII 字符串做恒定时间比较会抛异常，本该 401 变成 500）。

---

## D. 明确不建议移植

| 内容 | 原因 |
|---|---|
| **整个训练栈**（trainer / worker / 训练路由 / 训练显存估算） | Unsloth 的本体业务。OmniStudio 定位是「本地模型工作站」不是训练平台，移植等于开一条新产品线。 |
| **in-process diffusers 图像栈**（约 30 个 diffusion_* 模块） | 需要完整 torch + diffusers 常驻，且大量是猴补丁 torch/diffusers 内部。OmniStudio 的 Python 面只有三个 worker 脚本，扛不住也不该扛。要补无显卡图像能力走 C11 的子进程路线。 |
| **Python 依赖栈安装与治理**（wheel / uv / transformers 版本矩阵，其中一个文件 3126 行） | 纯 Python 生态问题，OmniStudio 只需 pip install 几个包，复杂度差两个数量级。**唯一例外是 B1 的 install manifest，它是通用的。** |
| **沙箱 sitecustomize** | CPython 启动钩子机制，Bun 无对应物。OmniStudio 的 Landlock helper 是更合适的方向。 |
| **Colab 集成** | 桌面应用无 notebook 场景。 |
| **FastAPI/ASGI 中间件栈本身** | Electrobun 侧没有 ASGI 层，容器形态搬不过去。**要移的是里面的策略而非容器**：CORS 预检 `max_age=60`（浏览器缓存的预检会在远程访问关闭后仍打进来，已实测）、按路径分级的 body 上限、CSP 逐响应 nonce、/docs 资产本地化（localStorage 按 origin 而非 path 隔离，CDN 脚本能读到同源 token）。 |
| **Data Recipe / 合成数据流水线** | 服务于训练。**但其「第三方能力做成独立可安装包 + 一个入口」的打包模式**可作为 OmniStudio Skills/插件体系的参考。 |
| **模型导出**（GGUF 转换/合并/量化） | 训练产物的下游。OmniStudio 用户是下现成的 GGUF，不产出。 |

---

## 建议的落地顺序（若只做三件）

1. **B1 安装完整性 manifest** —— 零依赖、直译、立刻消除「引擎看起来装好了其实没有」这一类最难查的 bug。
2. **B2 下载 manifest + cancel marker** —— 本项目已为此流过血（真机丢过 20+ GB 权重），当前解法缺一个 ground truth。
3. **B3 tool-call healing 子集** —— 本地 GGUF + Agent 是核心场景，而 `pi-agent-core` 不会替你处理模型吐成文本的 tool call。
