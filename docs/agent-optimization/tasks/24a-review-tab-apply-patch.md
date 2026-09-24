# 任务 24a：审查页签与时间轴摘要都漏掉了 `apply_patch`

工作树根目录：`/home/xixi/Git/OmniStudio/.claude/worktrees/agent-optimize`

## 允许改动的文件（只有这三个）

1. `apps/studio/src/mainview/app/agent/timeline.tsx` —— 只许把 `patchFilePaths` 改成导出，并改第 396 行那处判断
2. `apps/studio/src/mainview/app/agent/review-tab.tsx` —— 只许改 `useSessionChanges`
3. `apps/studio/src/mainview/app/agent/review-apply-patch.test.ts` —— 你要新建的测试文件

别的文件一个都不许碰。

## 现状

系统提示第 724 行明确告诉模型：

```
724    "3. 改代码优先用 apply_patch：一个补丁可以同时改多个文件，而且要么全改要么全不改；" +
```

也就是说 **`apply_patch` 是 agent 改代码的首选工具**。

`timeline.tsx` 的 `summarizeEdit`（第 113 到 150 行）**已经支持补丁**——第 131 到 145 行专门处理 `value.patch`，按 `+` / `-` 前缀算增删行数。同文件第 50 行还有个 `patchFilePaths`，能从补丁段落头解析出改动到的文件列表。

但两个消费点把它漏了：

**一、`review-tab.tsx` 第 47 行**（「审查」页签在工作区不是 git 仓库时的回落）：

```
46        if (event.kind !== "tool_start") continue;
47        if (event.toolName !== "write_file" && event.toolName !== "edit_file") continue;
```

**二、`timeline.tsx` 第 396 行**：

```
396      () => (toolName === "edit_file" || toolName === "write_file" ? summarizeEdit(start.args) : null),
```

而同文件第 334 行、第 254 到 256 行都是把三个编辑工具一起认的——只有这两处漏了。

## 缺陷

**审查页签不显示补丁的改动**。用户点「审查」是为了看这一轮 agent 改了什么；而 agent 被系统提示要求优先用 `apply_patch`，于是**最主要的改动来源在审查列表里根本不出现**。工作区是 git 仓库时还能靠 `git status` 兜住，不是仓库时（临时目录、非版本化的工作区）就什么都看不到。

**时间轴的编辑摘要对补丁也不显示**：`apply_patch` 那条工具行拿不到「增删了多少行」的摘要。

## 期望语义

**一、`timeline.tsx` 第 396 行**把 `apply_patch` 加进去，与第 334 行保持一致。

**二、`patchFilePaths`（第 50 行）改成导出**，`review-tab.tsx` 要用它。

**三、`review-tab.tsx` 的 `useSessionChanges` 认 `apply_patch`。** 注意这里不能只在第 47 行加一个工具名就完事——补丁的参数里**没有 `path` 字段**（第 52 行是按 `path` 取的），一个补丁还可能同时改多个文件。所以要分两条路：

- `write_file` / `edit_file`：走现在这条，从 `args.path` 取单个文件；
- `apply_patch`：用 `patchFilePaths(args.patch)` 取出**所有**被改文件，逐个计入。

增删行数怎么摊到多个文件上：`summarizeEdit` 给的是整份补丁的合计。**不要为此去写一个新的按文件切分的 diff 解析器**——那是另一件事，也容易写错。这次按下面这个口径来，并在注释里写明：

- 补丁只改一个文件时，把合计数记到那个文件上（准确）；
- 改多个文件时，每个文件都登记进列表（这样「改了哪些文件」是准的），增删行数**记为整份补丁的合计除以文件数、向上取整**，并在注释里说明这是近似值、精确到文件的拆分留待后续。

`tool` 字段记 `event.toolName`（也就是 `"apply_patch"`），让界面能看出来源。

## 不要做的事

- 不要动 `summarizeEdit` 本身（它已经支持补丁）
- 不要动 `patchFilePaths` 的解析正则
- 不要动 git 仓库那条主路径（只改「不是 git 仓库时的回落」这一支）
- 不要写新的 diff 解析器
- 不要改界面布局或文案

## 测试要求

新建 `apps/studio/src/mainview/app/agent/review-apply-patch.test.ts`（`.ts`，不需要 DOM）。

`useSessionChanges` 是个 hook，直接测它要 DOM 环境。**所以这次换个测法**：把 `patchFilePaths` 和 `summarizeEdit` 都是导出的纯函数这一点利用起来，测它们在补丁输入下的行为；hook 里的接线靠「读 diff + 现有用例不红」保证。

至少覆盖这 4 条：

1. **`patchFilePaths` 能从一份多文件补丁里取出全部文件名**（Add / Update / Delete 三种段落头各来一个）。
2. **`patchFilePaths` 对不含段落头的文本返回空数组**（不会误报）。
3. **`summarizeEdit` 对补丁参数算得出增删行数**：造一份 `{ patch: "..." }` 的 args JSON，断言 `added` / `removed` 与补丁里的 `+` / `-` 行数一致，且 `+++` / `---` 不被算进去。
4. **`summarizeEdit` 对 `write_file` / `edit_file` 的参数行为不变**（防止改动波及旧路径）。

如果你认为有办法在不引入 DOM 的前提下也测到 `useSessionChanges` 的接线，可以加，但**不要为此搭 happy-dom 脚手架**——那超出这条任务的范围。

## 验收标准（汇报第 5 节逐条填）

- [ ] `timeline.tsx` 第 396 行加上了 `apply_patch`
- [ ] `patchFilePaths` 已导出
- [ ] `review-tab.tsx` 对补丁走 `patchFilePaths`，多文件都登记
- [ ] 增删行数的近似口径写进了注释
- [ ] `summarizeEdit`、解析正则、git 主路径、界面布局都没动
- [ ] 没有写新的 diff 解析器
- [ ] 既有用例全绿
- [ ] 源码改动（两个文件合计）不超过 40 行

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/24a-review-tab-apply-patch.json
```

输出原样贴进汇报第 4 节。
