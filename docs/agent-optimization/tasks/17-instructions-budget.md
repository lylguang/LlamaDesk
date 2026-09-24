# 任务 17：指令文件超预算时，**最该保留的那一层最先被丢**

工作树根目录：`/home/xixi/Git/OmniStudio/.claude/worktrees/agent-optimize`

## 允许改动的文件（只有这两个）

1. `apps/studio/src/bun/agent-instructions.ts` —— 源码，只许改 `truncateInstructions` 这一个函数
2. `apps/studio/src/bun/agent-instructions.test.ts` —— 既有测试文件，**只许加用例，现有 20 条一条都不许删、不许改**

别的文件一个都不许碰。特别注意：**不要动 `discoverInstructionFiles`、不要动段落去重那一套、不要改默认上限 8KB**。

## 现状

`apps/studio/src/bun/agent-instructions.ts` 第 148 到 173 行：

```
148  export function truncateInstructions(
149    files: InstructionFile[],
150    maxBytes: number,
151  ): { files: InstructionFile[]; truncated: boolean } {
152    if (maxBytes <= 0) return { files, truncated: false };
153    let remaining = maxBytes;
154    const kept: InstructionFile[] = [];
155    let truncated = false;
156    for (const file of files) {
157      const size = Buffer.byteLength(file.contents, "utf8");
158      if (size <= remaining) {
159        kept.push(file);
160        remaining -= size;
161        continue;
162      }
163      if (remaining > 0) {
164        const slice = Buffer.from(file.contents, "utf8").subarray(0, remaining);
165        // 别把多字节字符切成半个：截断处往前收到最后一个完整字符。
166        const text = new TextDecoder("utf-8").decode(slice).replace(/�+$/, "");
167        kept.push({ ...file, contents: text });
168      }
169      truncated = true;
170      break;
171    }
172    return { files: kept, truncated };
173  }
```

传进来的 `files` 顺序由 `discoverInstructionFiles`（第 128 到 145 行）决定，它的注释写得很清楚：

```
128   * 收集要注入的项目指令：用户级在前，项目链路（根 → 工作区）在后。
```

也就是**从最泛到最具体**：用户级 → 项目根 → ……→ 工作区自己那份。

## 缺陷

`truncateInstructions` 就按这个顺序从头吃预算，吃光就 `break`。

于是**最具体的那一层最先被丢**——而它恰恰是最该留的：工作区自己那份 `AGENTS.md` 讲的是当前这个项目/子目录的规矩，泛层讲的是通用偏好。

这不是理论问题。本仓库根目录那份 `AGENTS.md` 就有 **40,968 字节**，而默认上限是 8KB（第 33 行 `DEFAULT_PROJECT_DOC_MAX_BYTES = 8 * 1024`）。光根目录这一份就把预算吃干净，子目录里任何 `AGENTS.md` 一个字都进不去——而且模型完全不知道有这回事。

## 期望语义

**按「越具体越优先」分配预算，但输出仍保持原来的顺序。**

具体做法：

1. 分配阶段**倒着遍历** `files`（从最后一个、也就是最具体的那个开始），依次吃预算。
2. 某个文件放不下时，跟现在一样：剩余预算大于 0 就截一段塞进去（多字节字符不许切半，沿用第 164 到 166 行那套写法），然后 `truncated = true`，不再继续给更泛的层分配。
3. 输出时把保留下来的文件**按原来的先后顺序**排好再返回——不要把顺序倒过来给调用方。调用方 `assembleInstructionSection`（第 332 行附近）以及段落去重那套逻辑都依赖「泛在前、具体在后」这个顺序。
4. `truncated` 的语义不变：只要有任何内容被丢掉或截断，就是 `true`。
5. `maxBytes <= 0` 表示不限，行为不变。

一句话：**谁先吃预算**变了，**最后怎么排**没变。

## 不要做的事

- 不要改默认的 8KB 上限，也不要让它随上下文窗口缩放（那是另一条任务）
- 不要动 `discoverInstructionFiles` 的发现顺序
- 不要动段落去重
- 不要改截断说明的文案

## 测试要求

往 `apps/studio/src/bun/agent-instructions.test.ts` 的 `describe("体积上限与拼装", ...)` 里加用例。照现有第 94 行那条的写法构造 `InstructionFile[]`（字段是 `path` / `contents` / `source`，见第 35 到 41 行）。

至少覆盖这 4 条：

1. **泛层超大时，最具体那层仍然完整保留**：造三份——user 层 100 字节、project 根层 **远超预算**（比如 50000 字节）、workspace 层 200 字节；预算给 1000。断言结果里能找到 workspace 那份、且内容完整。
   （**这条就是本次要修的缺陷，改之前必须是红的**——现在 workspace 那份一个字都进不去。）
2. **输出顺序仍是原顺序**：上面那个场景里，如果 user 层也被保留了，它在结果数组里必须排在 workspace 那份**前面**。
3. **预算够时三份都在，且顺序、内容都与原来一致**（防止改过头）。
4. **多字节字符不被切半**：最具体那层是一大段中文、预算卡在半个字符处，断言结果里没有替换字符 `�`，且是合法字符串。

## 验收标准（汇报第 5 节逐条填）

- [ ] 预算按「越具体越优先」分配
- [ ] 输出顺序仍是原顺序（泛在前、具体在后）
- [ ] `truncated` 语义不变
- [ ] `maxBytes <= 0` 不限的行为不变
- [ ] 多字节截断的处理没被改坏
- [ ] 没有动 `discoverInstructionFiles` / 段落去重 / 默认上限 / 截断文案
- [ ] 现有 20 条用例一条没删没改，全绿
- [ ] 把 `agent-instructions.ts` 的改动还原后，第 1 条用例会变红（你自己先试一遍）
- [ ] 源码改动不超过 25 行

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/17-instructions-budget.json
```

输出原样贴进汇报第 4 节。
