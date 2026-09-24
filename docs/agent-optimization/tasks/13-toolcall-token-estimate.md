# 任务 13：token 估算把工具调用的参数整个漏掉了

工作树根目录：`/home/xixi/Git/OmniStudio/.claude/worktrees/agent-optimize`

## 允许改动的文件（只有这两个）

1. `apps/studio/src/shared/token-estimate.ts` —— 源码，只许改 `textOf` 这一个函数
2. `apps/studio/src/shared/token-estimate.test.ts` —— 你要新建的测试文件（现在不存在）

别的文件一个都不许碰。特别注意：**不要动 `tokenParts`、`tokensFromParts`、`estimateTokens`、`estimateMessagesTokens`**，也**不要动** `apps/studio/src/bun/agent-compaction.test.ts`（那里现有的 `describe("estimateTokens", ...)` 留着不动）。

## 现状

`apps/studio/src/shared/token-estimate.ts` 第 54 到 70 行：

```
54  /** 取出一条消息的纯文本（content 可能是字符串或分块数组）。 */
55  function textOf(message: MessageLike): string {
56    const content = message.content;
57    if (typeof content === "string") return content;
58    if (Array.isArray(content)) {
59      return content
60        .map((part) => {
61          if (!part || typeof part !== "object") return "";
62          const candidate = part as { text?: unknown; type?: unknown };
63          if (typeof candidate.text === "string") return candidate.text;
64          // 工具调用 / 工具结果也占上下文，用类型名占位，估算不至于漏掉它们。
65          return typeof candidate.type === "string" ? `[${candidate.type}]` : "";
66        })
67        .join(" ");
68    }
69    return "";
70  }
```

## 缺陷

工具调用分块的真实结构（见 `apps/studio/src/bun/agent-history.ts` 第 27 到 32 行）是：

```
27  type ToolCallBlock = {
28    type: "toolCall";
29    id: string;
30    name: string;
31    arguments: Record<string, unknown>;
32  };
```

它**没有 `text` 字段**，所以第 63 行不命中，掉到第 65 行，整块只算成 `[toolCall]` —— 折算下来两三个 token。

但它真实占的上下文是「工具名 + 参数序列化之后的全部内容」。最极端的是写文件：`write_file` 的 `arguments.content` 可能是几百行代码，真实开销上千 token，估算却只给两三个。

第 64 行那句注释写的是「估算不至于漏掉它们」——只能说没把整块当成 0，但数量级完全不对。

影响面（`estimateMessagesTokens` 的调用方）：

- `apps/studio/src/bun/agent.ts:2002` —— 判断要不要触发摘要
- `apps/studio/src/bun/agent-compaction.ts:52,58,66,70` —— 裁剪的预算账
- `apps/studio/src/bun/agent-context.ts:75` —— 界面上显示的上下文占用
- `apps/studio/src/bun/chat.ts:757` —— 没有 usage 元数据时的用量兜底

一个写过几次文件的回合，这四处全部被低估。低估的后果是该压缩时不压缩，直接顶到窗口上限——表现就是模型突然胡言乱语，或者请求直接报超长。

## 期望语义

`textOf` 处理分块时，除了现有的 `text` 分支，再认一种情况：

- 分块的 `type` 是 `"toolCall"` 时，把它的 `name` 和 `arguments` **序列化后的内容**一起计入。形如：类型占位 + 工具名 + `JSON.stringify(arguments)`。
- `name` 或 `arguments` 缺失时要能正常工作，不要抛错，也不要把 `undefined` 这种字样拼进去。
- `JSON.stringify` 用 try/catch 兜住，抛错时退回现在的行为（只算类型占位）。模型给的参数本来就是 JSON，理论上不会循环引用，但这里是估算路径，绝不能因为它把整个回合搞挂。
- 其它类型的分块（没有 `text`、也不是 `toolCall`）行为不变，仍然只算类型占位。
- `content` 是字符串、以及带 `text` 字段的分块，行为都不变。

## 不要做的事

- 不要动图片分块的估算（那是另一条任务）
- 不要改 `estimateTokens` 的折算比例（CJK 1 字 1 token、其它 4 字符 1 token）
- 不要动 `tokenParts` 的字符分类
- 不要为了「更准」去引入真正的分词器——这里就是要一个便宜的估算

## 测试要求

新建 `apps/studio/src/shared/token-estimate.test.ts`。这个目录下已经有不少测试（比如 `engines.test.ts`），照它们的写法搭架子即可，不需要临时目录。

至少覆盖这 5 条：

1. **带大参数的工具调用，估算值要跟参数体量同一量级**：造一个 `{ type: "toolCall", id: "t1", name: "write_file", arguments: { path: "a.ts", content: "<一大段内容>" } }`，断言 `estimateMessagesTokens` 的结果**不小于**那段内容单独 `estimateTokens` 的值。
   （**这条就是本次要修的缺陷，改之前必须是红的**——现在只会算出个位数。）
2. **参数里的中文按中文口径算**：参数内容换成一大段中文，断言结果同样不小于该段中文单独估算的值。
3. **工具名也计入**：两个除了 `name` 长度不同、其余相同的工具调用，长名字那个估算值更大。
4. **缺字段不炸**：`{ type: "toolCall" }`（没有 name、没有 arguments）能正常返回一个大于 0 的数，不抛错。
5. **老行为不变**：字符串 content、带 `text` 的分块、非 `toolCall` 的分块，三种情况的估算值与改动前一致（可以直接写死期望数字）。

## 验收标准（汇报第 5 节逐条填）

- [ ] `toolCall` 分块的参数被计入估算
- [ ] 工具名被计入估算
- [ ] 缺 `name` / 缺 `arguments` 时不抛错
- [ ] `JSON.stringify` 有 try/catch，抛错时退回类型占位
- [ ] 其它分块类型、字符串 content、带 `text` 的分块，行为都没变
- [ ] 没有动 `tokenParts` / `tokensFromParts` / `estimateTokens` / `estimateMessagesTokens`
- [ ] 没有动 `agent-compaction.test.ts`
- [ ] 把 `token-estimate.ts` 的改动还原后，第 1 条用例会变红（你自己先试一遍）
- [ ] 源码改动不超过 20 行

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/13-toolcall-token-estimate.json
```

输出原样贴进汇报第 4 节。
