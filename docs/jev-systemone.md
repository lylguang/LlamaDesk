# JEV / SystemOne：类型化判定

JEV 回答的是**被约束的问题**，不是生成文本：`choice`（在给定选项里选一个）、
`score`（在有序档位上打分）、`noul`（是/否）。答案带完整的概率分布与置信度，
输出 0 个 token（一次双向前向，不逐字解码）。

一句话说明它为什么在这个项目里：**让"分类 / 打分 / 判断"这类判断可比较、可设阈值、
可批量**，而不是每次都让聊天模型生成一段要解析的文字。

## 三个入口，一套协议

| 入口 | 用在哪 | 调用方式 |
|---|---|---|
| **JEV 页**（左侧一级菜单） | 人用 | 左栏顶部切「本地运行 / 云端接入」并配引擎，下面是 state 与问题；右栏看概率分布 |
| Agent 工具 | 应用内的 Agent 会话 | `jev_evaluate`（只读、免授权） |
| 网关 | 外部 agent / 脚本 / 其他语言 | `POST /v1/systemone` |

三者共用同一条 `runSystemOne`（`src/bun/systemone.ts`），所以页面上看到的结果与外部
agent 通过网关拿到的东西必然一致。

JEV 是**独立的一级菜单**（`app/jev/`，默认排在 Agent 与通话之间），页面结构对齐语音
合成页：**左栏是参数、右栏是产物**。

- 左栏顶部是「判定引擎」的分段切换：**本地运行**（装 laya-mlx 引擎 → 下权重 → 启动模型）
  / **云端接入**（Base URL + Key + 模型 + 测试连接）。下面接着是 state、问题清单与运行按钮。
  **切 tab 就是换后端**：它直接把 `SYSTEMONE_BACKEND` 写成 `local` / `cloud`，所以
  "在云端接入里填了 Key 却没被调用"这类事不会再发生（以前 tab 只是个视图，走哪条由
  `auto` 的本地优先定，本地地址一配云端就永远轮不到 —— `index.test.tsx` 有回归）。
- 右栏是概率分布结果；没跑之前是空态（居中图标 + 一句话）。
- 应用侧栏放**内置示例**（工单分派 / 简历评分 / 内容护栏 / 检索重排 / 意图路由），
  点一下把 state 与问题一起装进左栏 —— 这个页面最大的门槛是"我该问什么"。
- 示例内容是**中英各一份**（中文界面给中文工单），而模型名 / 原语名 / 路径这类
  照抄用的标识符保持英文。

塞进 Agent 的右侧窄面板摊不开（编辑器 + 概率分布需要整屏宽度），所以它是一级菜单。
Agent 与它的关系是"用"而不是"装"：Agent 通过 `jev_evaluate` 工具调它。

## 协议：与 TypeSafe 官方逐字段对齐

对齐的依据是实测，不是转述：

- `POST /v1/systemone`，请求 `{state, model, questions}`，响应 `{model, answers, usage}`；
- `GET /v1/models` 返回 `{models: [{name, description, release_date}]}`；
- 鉴权失败按官方的两种分法：**缺 Key → 403**（`Must supply an API key!…`）、
  **Key 无效 → 401**（`Cannot authenticate with the server.…`），body 都是
  `{"detail":{"error_type":"authentication_error","message":"…"}}`；
- 校验失败 422，body 是 FastAPI 形状 `{"detail":[{loc,msg,type,input,ctx}]}`；
- 成功与失败都带 `x-typesafe-request-id`（`req_` + 32 位 hex）；
- 模型别名：`jev-latest` / `jev-preview` → `jev-1.13.0`。

于是**官方 SDK 只改两行就能打到本机网关**：

```bash
TYPESAFE_BASE_URL=http://127.0.0.1:<网关端口>
TYPESAFE_API_KEY=<设置 → 网关里的 API Key>
```

这不是"我们希望如此"，而是被测试守着的：`src/bun/gateway.systemone.test.ts` 与
`scripts/systemone-smoke.ts` 用官方的 `@typesafe-ai/sdk` 真调一次，包括错误分类
（401 → `AuthenticationError`、422 → `UnprocessableEntityError`）与 `models.list()`。

`/v1/models` 是个刻意的**超集**：同时给 OpenAI 的 `data` 与 TypeSafe 的 `models`。
官方 JS SDK 只读 `wire.models`，OpenAI 客户端只读 `data`，两边都不看对方的字段 ——
分两个端点就做不到"换 Base URL 就能用"。

## 后端：你选哪条就走哪条（`auto` 只做兜底）

设置项 `SYSTEMONE_BACKEND` —— **在 JEV 页左栏的「判定引擎」里切**（本地运行 → `local`，
云端接入 → `cloud`；`mainview/app/jev/engine-panel.tsx` 的 `BACKEND_FOR_TAB`）：

- `local`：只用本地 —— 自建/局域网内的 TypeSafe 兼容服务（`SYSTEMONE_LOCAL_BASE_URL`），
  或托管的 laya-mlx 运行时（自建地址优先）；
- `cloud`：只用云端 —— `SYSTEMONE_CLOUD_BASE_URL` + `SYSTEMONE_CLOUD_API_KEY`（默认官方地址）；
- `auto`（仅"没选过"时的兜底，旧安装 / 外部写入 `omi` 或 CLI 时才会看到）：本地能用就用本地，
  否则云端，本地**连不上**时（只有 502/504）回落云端并留一条日志。

选定的后端是**硬选择**：`cloud` 时哪怕本地地址配着也不会被本地优先截走，`local` 时
本地连不上也不会偷偷改走云端（回落只属于 `auto`）。两条都由 `gateway.systemone.test.ts`
的「后端由设置决定」守着。

### 本地运行时（laya-mlx）

它同时登记进**设置 → 模型引擎**（`shared/local-engines.ts` 的 `LOCAL_ENGINE_SPECS` 一条 +
`bun/engine-catalog.ts` 一个适配器，自成一类 `systemone`）—— 引擎的安装 / 卸载 / 占用
在那页统一管，"管理模型"跳回 JEV 页。两页共用同一份安装与卸载实现，所以不会出现
"这一页说装了、那一页说没有"。

`bun/systemone-laya.ts` + `bun/systemone-laya-worker.py`：把开放权重的 Laya
（同一套 choice / score / noul 三原语）装进 `<dataDir>/engines/laya` 的托管 venv，
worker 走 JSON-lines stdio、按 weights 懒加载。三条约定：

- **只支持 Apple Silicon 的 macOS**（MLX 依赖），其他平台如实说"不支持"，
  不留一个装到一半的 venv；
- **卸载只删 venv**，权重留在 Hugging Face 缓存里（与引擎管理页的既有约定一致：
  引擎与权重分开管，重装不必重下几百 MB）；
- **引擎页可以显式下权重**：worker 支持 `models`（`local_files_only` 探缓存，报已落盘
  字节）/ `download`（后台线程下载 + 主线程每 500ms 报真实字节）/ `load`（装进内存，不跑
  推理）/ `unload`。界面上的「已下载 / 下载中 / 运行中」直接来自这四条；
- **不预先下权重也能用**：第一次判定时 laya-mlx 自己会把权重拉下来，只是那时才慢；
  所以本地那条超时单独一个设置项（见下）。

本地后端与云端有三处**有意的差异**，都在 `systemone.ts` 里：

1. **模型名归一化只对托管运行时做。** 运行时需要权重 repo 与一个回显标签，所以
   `laya-*`/云端别名都会解析成本地权重与版本号；而**自建的本地服务原样转发**
   —— 那是别人自己的服务器，模型名由它定义（用户的 laya 服务就叫 `jev-latest`），
   改名会让它认不出来，"只换 Base URL 就能用"这条承诺就断了。云端后端收到 `laya-*`
   仍会换成云端默认模型（同理：客户端大概率没改 `model` 字段），完全不认识的名字
   原样透传，让官方 API 自己报错。
2. **`auto` 下本地连不上会回落云端**（只对 502/504）。本地服务配了但没起来时安静地
   失败是最糟的表现——用户明明配了能用的云端 Key。本地服务正常回的 4xx **不**回落：
   那是请求的问题，换云端只会再错一次还多花钱。回落会记 `systemone.fallback_cloud`。
3. **超时不同**：本地运行时是 `SYSTEMONE_LOCAL_TIMEOUT_MS`（默认 600s，首次要下权重），
   HTTP（云端 / 本地服务）是 `SYSTEMONE_TIMEOUT_MS`（默认 60s）。

### 免费

`SYSTEMONE_PRICING` 恒为 0：本地是用户自己的机器，云端是用户自己的 Key，
我们不转售也不加价。用量账本照记一行（渠道「JEV 类型化判定」），只记次数与 tokens，
**不记金额**。界面上的「免费」标签直接读这个常量。

## 校验

`src/shared/systemone.ts` 是唯一的协议来源：类型、模型目录、校验、错误体、请求 id。
它只实现官方 OpenAPI 里声明过的约束（`minProperties: 1`、`minItems: 1`、必填、类型、
字面量），**刻意不额外加限制** —— 官方 SDK 在客户端已经拦掉的（例如 score 少于两档）
在这里放行，避免把官方能过的请求拒掉。

## 文件一览

| 文件 | 作用 |
|---|---|
| `src/shared/systemone.ts` | 协议唯一来源：类型 / 校验 / 模型目录 / 错误体 / 请求 id / 价格 0 |
| `src/bun/systemone.ts` | 后端解析（本地优先）+ 调用 + 用量记账 + 事件日志 |
| `src/bun/systemone-laya.ts` | 本地运行时的安装 / 卸载 / 常驻 worker 生命周期 |
| `src/bun/systemone-laya-worker.py` | MLX worker（JSON-lines，官方形状 ↔ laya-mlx 的抹平处） |
| `src/bun/systemone-tools.ts` | Agent 工具 `jev_evaluate`（答案 → 可读文本） |
| `src/bun/gateway.ts` | `POST /v1/systemone` + `/v1/models` 的 TypeSafe 字段 + OpenAPI |
| `src/mainview/app/jev/index.tsx` | JEV 页的编排（左参数栏 + 右结果栏） |
| `src/mainview/app/jev/engine-panel.tsx` | 左栏顶部：引擎切换（本地运行 / 云端接入，切 tab 即写 `SYSTEMONE_BACKEND`）与各自配置；本地侧含装引擎 / 下权重 / 启停 |
| `src/mainview/app/jev/questions.tsx` | 左栏下半：state、问题清单（按原语切换 criteria 形状）、运行 |
| `src/mainview/app/jev/answers.tsx` | 右栏：空态与概率分布 / 置信度 / 调用示例 |
| `src/mainview/app/jev/sidebar.tsx` | 侧栏：内置示例清单 |
| `src/mainview/app/jev/examples.ts` | 示例数据（中英各一份） |
| `src/mainview/app/jev/drafts.ts` | 纯逻辑：草稿 → 官方请求体、调用示例文本（带单测） |
| `src/mainview/stores/jev.ts` | 页面状态（侧栏与主区共用：点示例改左栏草稿） |
| `src/bun/builtin-skills/jev-typed-decisions/` | 内置技能：怎么写问题、怎么读答案、可复制的例子 |

## 排障

- `503 configuration_error`：没有可用后端 —— 本地未装且本地地址为空、云端又没 Key，
  或后端被显式选成了没配好的那一侧。去 JEV 页左栏的「判定引擎」切到那侧补齐
  （云端接入填 Key，本地运行装引擎 / 填自建地址）。
- `502 / 504`：后端连不上或超时。`omi logs --source systemone` 里有
  `systemone.request_failed` / `systemone.local_failed` / `systemone.laya.*`。
- 本地运行时起不来：先看 `systemone.laya.fatal`（通常是平台不对或 venv 未装），
  再看 `systemone.laya.spawn_failed`。
- 网关侧失败另外记 `systemone.gateway.failed`（带 status / backend / model）。

## 检查

```bash
bun run --cwd apps/studio test src/shared/systemone.test.ts src/mainview/app/jev/drafts.test.ts \
  src/bun/systemone-tools.test.ts src/bun/systemone-laya.test.ts src/bun/gateway.systemone.test.ts
bun run --cwd apps/studio scripts/systemone-smoke.ts
```
