# JEV / SystemOne 协议参考

与 TypeSafe 官方逐字段对齐（实测 `https://api.typesafe.ai/openapi.json` 与线上的
鉴权失败响应）。本应用网关（`POST /v1/systemone`）与本文件描述的是同一套协议。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/systemone` | 类型化判定。这是唯一的推理端点 |
| GET | `/v1/models` | 模型与别名。本应用的网关同时返回 OpenAI 的 `data` 与 TypeSafe 的 `models` |

官方 Base URL 是 `https://api.typesafe.ai`；本机网关是 `http://127.0.0.1:<网关端口>`。
两个 SDK 都按 `base_url + "/v1/systemone"` 拼接，所以 Base URL 里**不要**带 `/v1`。

## 鉴权

`Authorization: Bearer <API_KEY>`。本机的 Key 在 设置 → 网关 里创建（可多把、可停用）。

鉴权失败时官方分两种，我们照抄：

| 情况 | 状态码 | body |
|---|---|---|
| 请求里没有 Authorization 头 | **403** | `{"detail":{"error_type":"authentication_error","message":"Must supply an API key! Check your request and try again."}}` |
| Key 存在但无效 | **401** | `{"detail":{"error_type":"authentication_error","message":"Cannot authenticate with the server. Please check your API key and try again."}}` |

SDK 按状态码建异常类：403 → `PermissionDeniedError`，401 → `AuthenticationError`。
所以**不要**把两种混成一个码，客户端的重试/提示逻辑会走错分支。

## 请求

```jsonc
{
  "state": "…",              // 必填。字符串 / 对象 / 数组（null 会被拒）
  "model": "jev-latest",     // 必填。别名或版本号，见 /v1/models
  "questions": {             // 必填，至少 1 个
    "<你取的名字>": {
      "type": "noul",        // noul | choice | score
      "instructions": "…",   // 可选。字符串 / 对象 / 数组 / null
      "criteria": …          // choice / score 必填，noul 可选
    }
  }
}
```

`criteria` 按类型：

| type | criteria | 约束 |
|---|---|---|
| `choice` | 映射：`{"选项名": "什么情况下选它"}` | 必填，至少 1 项；值可以是字符串/对象/数组/`null`（`null` = 只用名字）；最多 255 个选项 |
| `score` | **有序数组**：`["最低档描述", …, "最高档描述"]` | 必填，至少 1 项（官方 JS SDK 在客户端拦 <2 项）；文档说 API 接受最多 10 档。**数组下标就是档位号，从 0 起** |
| `noul` | 可选：`{"true": "什么算 yes", "false": "什么算 no"}` | 两个键都可选 |

`instructions` 与 `criteria` 的每一项都可以是**结构化内容**（对象/数组），
用来把"要判断的问题"和"它要参照的数据"分开。对象里的字段名是你自己的约定，
官方推荐的写法是 `{"question": "…", "focus": "…", "what": "…", "not_for": "…", "examples": [...]}`。

### 校验失败（422）

FastAPI / pydantic v2 形状，`loc` 精确指到字段：

```json
{ "detail": [
  { "loc": ["body", "questions", "urgency", "criteria"],
    "msg": "List should have at least 1 item after validation, not 0",
    "type": "too_short",
    "input": [],
    "ctx": { "min_length": 1 } }
] }
```

常见的 `type`：`missing`（缺必填）、`too_short`（数组/映射为空）、`literal_error`
（`type` 不是三个原语之一）、`string_type` / `list_type` / `model_attributes_type`
（类型不对）、`json_invalid`（body 不是合法 JSON）。

## 响应

```jsonc
{
  "model": "jev-1.13.0",        // 实际回答的模型，可能与请求里的别名不同
  "answers": {
    "<请求里的问题名>": { … }    // 每个 answer 的 type 与对应问题一致
  },
  "usage": { "input_tokens": 332, "output_tokens": 18 }
}
```

三种 answer：

```jsonc
// noul —— 没有 confidence（两个结果，一个概率就说完了）
{ "type": "noul", "noul": 0.97 }

// choice
{ "type": "choice", "choice": "billing", "confidence": 0.93,
  "probabilities": { "billing": 0.93, "technical": 0.05, "sales": 0.02 } }

// score —— score 是期望档位（可以是小数），legend 把档位号映射回你的描述
{ "type": "score", "score": 2.4, "confidence": 0.71,
  "legend": { "0": "not urgent", "1": "soon", "2": "critical" },
  "probabilities": { "0": 0.02, "1": 0.56, "2": 0.42 } }
```

- `probabilities` 的值加起来约等于 1（各实现有四位小数舍入，不保证精确）。
- `confidence` = 分布的集中度，0（完全平摊）到 1（全压一个选项）。**不是正确率**。
- 响应头 `x-typesafe-request-id` 是排障用的请求 id（形状 `req_` + 32 位 hex）。

## 其它状态码

| 状态码 | 含义 |
|---|---|
| 400 | 请求无效 |
| 404 | 资源不存在 |
| 429 | 限流（官方会带 `retry-after` / `retry-after-ms`，SDK 自动退避） |
| 502 / 504 | （本机网关特有）后端连不上 / 超时 |
| 503 | （本机网关特有）没有可用的 JEV 后端：本地运行时未装 + 没配云端 Key |
| 529 | 服务过载（官方） |

## 模型

`GET /v1/models` 的 `models` 数组（本机网关同时给 OpenAI 的 `data`）：

| name | 后端 | 说明 |
|---|---|---|
| `jev-latest` | 云端 | 官方旗舰模型的稳定别名 → 解析为 `jev-1.13.0` |
| `jev-preview` | 云端 | 最新（含非正式）版本，当前与 latest 同指 |
| `jev-1.13.0` | 云端 | 版本号形式，别名指向的实际模型 |
| `laya-latest` | 本地 | Laya 英文权重（ModernBERT-large 421M），MLX |
| `laya-multilingual` | 本地 | Laya 多语言（mmBERT-base 322M），中文内容优先用它 |
| `laya-typed-decisions` | 本地 | 上游 typed-decisions 工作流权重 |

- 头三张卡片与官方一致的字段是 `name` / `description` / `release_date`。
- 传给 `model` 时按后端归一化：自建的本地服务原样转发；托管运行时会解析成本地权重；
  云端会把本地名字（`laya-*`）换成云端默认模型。完全不认识的名字原样透传，让
  官方 API 自己报错（掩盖拼写错误更糟）。

## 本机网关的调用示例

```bash
OMNI=http://127.0.0.1:<网关端口>
KEY=$OMNI_GATEWAY_KEY      # 设置 → 网关

curl -s "$OMNI/v1/models" -H "Authorization: Bearer $KEY" | jq '.models[].name'

curl -s "$OMNI/v1/systemone" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{
  "state": "The export button crashes the settings page in Safari. No workaround.",
  "model": "jev-latest",
  "questions": {
    "severity": { "type": "score", "instructions": "How severe is the issue?",
      "criteria": ["Cosmetic; no impact", "Degraded feature, workaround exists", "Blocking; no workaround"] }
  }
}' | jq '.answers.severity'
```

## 本应用的三个入口（同一个后端）

| 入口 | 用在哪 | 怎么调 |
|---|---|---|
| Agent 工具 | 应用内的 Agent 会话 | 工具名 `jev_evaluate`，参数 `{state, questions, model?}` |
| RPC | 界面 / 小应用 | `systemoneRun` / `systemoneStatus` / `systemoneTest` |
| HTTP | 外部 agent、脚本、其他语言 | `POST /v1/systemone`（本文档） |

后端选择（设置项 `SYSTEMONE_BACKEND`，应用里在 JEV 页左栏的「判定引擎」切换）：

- `local`：只用本地（自建 `SYSTEMONE_LOCAL_BASE_URL`，或托管的 laya-mlx 运行时；自建地址优先）；
- `cloud`：只用云端（`SYSTEMONE_CLOUD_BASE_URL` + `SYSTEMONE_CLOUD_API_KEY`）；
- `auto`（只在"从没选过后端"时出现，也是默认值）：本地能用就用本地，否则云端；
  本地**连不上**时（只有 502/504）自动回落云端并留一条日志。

回落只属于 `auto`：显式选定 `local` / `cloud` 之后，另一侧不会被拿来"兜底" ——
用户选哪条就走哪条，连不上就如实报错。

关于 `model` 的归一化，按后端不同：**自建的本地服务原样转发**（名字由那台服务定义）；
托管的本地运行时会解析成本地权重与版本；云端会把你写的本地名字（`laya-*`）换成
云端默认模型，其他名字原样透传。

价格恒为 0：本地是你自己的机器，云端是你自己的 Key，我们不转售也不加价。
用量账本照样记一行（渠道「JEV 类型化判定」），只记次数与 tokens，不记金额。
