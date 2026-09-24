# 任务 01：修掉 `edit_file` 工具静默写坏文件的两个缺陷

工作树根目录：`/home/xixi/Git/OmniStudio/.claude/worktrees/agent-optimize`
下面所有路径都相对这个根目录。

## 允许改动的文件（只有这两个）

1. `apps/studio/src/bun/agent-tools.ts` —— 源码，只许改 `createEditFile` 里那一段
2. `apps/studio/src/bun/agent-tools.edit.test.ts` —— 你要新建的测试文件（现在不存在）

别的文件一个都不许碰。

## 现状

`apps/studio/src/bun/agent-tools.ts` 第 552 到 574 行，`edit_file` 工具的 `execute`。当前代码逐字如下（行号是文件里的真实行号）：

```
558        const original = readFileSync(target, "utf8");
559        const occurrences = original.split(params.old_str).length - 1;
560        if (occurrences === 0) return errorResult(`old_str not found in ${target}${EDIT_MISMATCH_HINT}`);
561        if (occurrences > 1 && !params.replace_all) {
562          return errorResult(
563            `old_str occurs ${occurrences} times in ${target}. Pass replace_all=true or make old_str unique.` +
564              "（更稳的做法：把 old_str 扩到上下几行，让它只匹配一处。）",
565          );
566        }
567        const next = params.replace_all
568          ? original.split(params.old_str).join(params.new_str)
569          : original.replace(params.old_str, params.new_str);
570        writeFileSync(target, next, "utf8");
```

## 缺陷一：`new_str` 里的 `$` 被当成替换模式

第 569 行走的是 `String.prototype.replace`。它的第二个参数是**替换模式字符串**，里面的 `$&`、`` $` ``、`$'`、`$$` 会被当成特殊记号展开，而不是原样写入。

举例：文件内容是 `AAA`，`old_str = "AAA"`，`new_str = "x$&y"`。期望落盘 `x$&y`，实际落盘 `xAAAy`。模型想写一段含 `$&` 的正则或 shell 代码时，文件就被悄悄写错了，而工具还报告成功。

第 568 行的 `split().join()` 没有这个问题（`join` 不解释 `$`），所以 `replace_all = true` 这条路是对的，**不要动它**。

## 缺陷二：`old_str` 为空字符串时毁掉整个文件

`old_str = ""` 时，第 559 行 `"abc".split("")` 得到 `["a","b","c"]`，`occurrences` 算出 2，不等于 0，所以第 560 行拦不住。

接着如果 `replace_all = true`，第 568 行 `"abc".split("").join("X")` 得到 `"aXbXc"` —— 在每两个字符之间都插了一遍 `new_str`，整个文件被毁。`replace_all = false` 时则会在文件开头插一段。

## 期望语义

- **缺陷一**：单次替换的结果必须是「把第一处 `old_str` 原样换成 `new_str`」，`new_str` 里的任何字符都按字面写入，不做任何展开。按下标切片拼接是最直接的写法：找到第一处出现的位置，取前半段 + `new_str` + 后半段。（用 `replace` 配函数形式的替换值也可以，你自己选。）
- **缺陷二**：`old_str` 为空字符串时，在读文件之前就返回 `errorResult`，提示语写清「old_str 不能为空」。不要写文件。
- 其余行为全部保持不变：找不到时的报错、出现多次且没开 `replace_all` 时的报错、返回文案、`recordArtifact` 调用，都不许改。

## 测试要求

新建 `apps/studio/src/bun/agent-tools.edit.test.ts`。照着同目录 `agent-tools.patch.test.ts` 的开头写法搭架子（临时工作区、`ToolContext`、取工具的辅助函数都可以照抄，它第 1 到 38 行就是模板）。`edit_file` 工具从 `buildAgentTools` 里取。

至少覆盖这 5 条，每条都要断言**落盘后的文件内容**，不能只断言返回文案：

1. `new_str` 含 `$&`：落盘内容逐字符等于 `new_str` 原文，不含被展开的痕迹。
2. `new_str` 含 `$$` 和 `` $` ``：同上。
3. `old_str = ""`：返回的是错误结果，并且**文件内容一个字节都没变**。
4. 正常的单次替换仍然正确（防止改坏）。
5. `replace_all = true` 且 `new_str` 含 `$&` 时仍然正确（这条现在就是对的，属于防回归）。

## 验收标准（汇报第 5 节逐条填）

- [ ] 单次替换时 `new_str` 按字面落盘，`$&`、`$$`、`` $` ``、`$'` 都不展开
- [ ] `old_str` 为空时返回错误且不写文件
- [ ] 找不到 / 出现多次这两条原有报错行为没变
- [ ] `replace_all` 那条路径的代码没被改动
- [ ] 新测试文件 5 条用例齐全，且每条都断言了落盘内容
- [ ] 把 `agent-tools.ts` 的改动还原后，新测试会变红（你自己先试一遍）
- [ ] 源码改动行数不超过 30 行

## 门命令

交付前在工作树根目录跑：

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/01-edit-file-dollar.json
```

把它的完整输出原样贴进汇报第 4 节。出现 `RESULT FAIL` 就是没做完。
