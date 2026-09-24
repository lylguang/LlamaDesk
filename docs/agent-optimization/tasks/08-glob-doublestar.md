# 任务 08：修掉 `glob` 工具的 `**/` 匹配不到根层文件

工作树根目录：`/home/xixi/Git/OmniStudio/.claude/worktrees/agent-optimize`
下面所有路径都相对这个根目录。

## 允许改动的文件（只有这两个）

1. `apps/studio/src/bun/agent-tools.ts` —— 源码，只许改 `globToRegExp` 这一个函数
2. `apps/studio/src/bun/agent-tools.glob.test.ts` —— 你要新建的测试文件（现在不存在）

别的文件一个都不许碰。特别注意：**不要改 `walkDir`、不要改 `createGlob`、不要改 `grep`**。

## 现状

`apps/studio/src/bun/agent-tools.ts` 第 341 到 362 行，当前代码逐字如下：

```
341  /** 简易 glob：`**` 匹配任意层级，`*` 匹配非分隔符字符，`?` 匹配单个字符。 */
342  function globToRegExp(pattern: string): RegExp {
343    let re = "";
344    for (let i = 0; i < pattern.length; i++) {
345      const ch = pattern[i]!;
346      if (ch === "*") {
347        if (pattern[i + 1] === "*") {
348          re += ".*";
349          i++;
350        } else {
351          re += "[^/]*";
352        }
353      } else if (ch === "?") {
354        re += "[^/]";
355      } else if (".+^${}()|[]\\".includes(ch)) {
356        re += `\\${ch}`;
357      } else {
358        re += ch;
359      }
360    }
361    return new RegExp(`^${re}$`);
362  }
363  }
```

（第 363 行那个多余的括号是本说明排版造成的，文件里没有，不要去动。）

## 缺陷

`**` 被直译成 `.*`，紧跟其后的 `/` 就成了**必须出现**的字符。

- `**/*.ts` 编译出 `^.*/[^/]*\.ts$`。工作区根目录下的 `a.ts`，相对路径就是 `a.ts`，里面没有斜杠，匹配不上。
- `src/**/*.test.ts` 编译出 `^src/.*/[^/]*\.test\.ts$`，匹配不到 `src/a.test.ts`。

也就是说 `**/` 要求「至少一层目录」，而 glob 的通行语义是「零层或多层目录」。

这两个例子正是 `createGlob` 工具描述里写给模型看的示范写法（第 428 行），现在工具连自己文档里的例子都匹配不全。模型用 `**/*.ts` 找文件时，根目录下的文件会被静默漏掉，它拿到的是一份不完整的清单却以为是全部。

## 期望语义

- `**/` 表示「零层或多层目录」。`**/*.ts` 必须同时匹配 `a.ts` 和 `src/deep/a.ts`。
- 不跟 `/` 的单独 `**`（比如 `src/**`）继续表示「任意字符，可跨目录」，行为不变。
- 单个 `*` 仍然只匹配非 `/` 的字符，`?` 仍然匹配单个非 `/` 字符，正则元字符仍然要转义。行为都不许变。
- 这次**不要**动花括号 `{a,b}` 的支持，那是另一条任务。现在 `{` `}` 按字面转义，保持原样。

提示：做法是在看到 `**` 时多看一眼下一个字符，如果是 `/` 就把 `**/` 整体译成一个「可选的目录前缀」，并把两个字符都跳过。

## 测试要求

新建 `apps/studio/src/bun/agent-tools.glob.test.ts`。照着同目录 `agent-tools.patch.test.ts` 开头第 1 到 38 行的写法搭架子（临时工作区、`ToolContext`、取工具的辅助函数）。

`globToRegExp` 没有导出，**不要为了测试去导出它**。通过 `buildAgentTools` 取出 `glob` 工具、在临时工作区里真建几个文件来测，这样测的是真实行为。

建议的工作区结构：根目录放 `a.ts` 和 `readme.md`，`src/` 下放 `b.ts`，`src/deep/` 下放 `c.ts` 和 `d.test.ts`。

至少覆盖这 6 条：

1. `**/*.ts` 能匹配到根层的 `a.ts`（**这条就是本次要修的缺陷，改之前必须是红的**）
2. `**/*.ts` 同时还能匹配到 `src/b.ts` 和 `src/deep/c.ts`（防止改过头）
3. `**/*.ts` 不匹配 `readme.md`
4. `src/**/*.test.ts` 能匹配到 `src/deep/d.test.ts`
5. 单独的 `*.ts`（不带 `**`）只匹配根层的 `a.ts`，不匹配 `src/b.ts`
6. `?` 的行为没变：用一个能区分「单字符」和「多字符」的用例

断言要针对工具返回的匹配列表本身，不要只断言「没报错」。

## 验收标准（汇报第 5 节逐条填）

- [ ] `**/*.ts` 匹配得到根层文件
- [ ] `**/*.ts` 仍然匹配得到多层目录下的文件
- [ ] `src/**/*.test.ts` 匹配得到 `src/deep/d.test.ts`
- [ ] 单个 `*` 不跨目录的行为没变
- [ ] `?` 的行为没变
- [ ] 正则元字符仍然被转义（没有把 `.` 之类当成通配）
- [ ] 没有动花括号，没有动 `walkDir` / `createGlob` / `grep`
- [ ] 没有为了测试而导出 `globToRegExp`
- [ ] 把 `agent-tools.ts` 的改动还原后，第 1 条用例会变红（你自己先试一遍）
- [ ] 源码改动行数不超过 25 行

## 门命令

交付前在工作树根目录跑：

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/08-glob-doublestar.json
```

把它的完整输出原样贴进汇报第 4 节。出现 `RESULT FAIL` 就是没做完。
