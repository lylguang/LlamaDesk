# 任务 02b：凭据文件的覆盖源用 `/dev/null`，沙箱里读到的是「权限拒绝」而不是空文件

工作树根目录：`/home/xixi/Git/OmniStudio/.claude/worktrees/agent-optimize`

## 允许改动的文件（只有这两个）

1. `apps/studio/src/bun/agent-sandbox.ts` —— 只许**新增**一个导出函数，并在 `wrapShellCommand` 调 `bwrapArgs` 那一处多传一个参数
2. `apps/studio/src/bun/agent-sandbox.test.ts` —— 既有测试文件，只许加用例；有冲突照实报、不硬改

别的文件一个都不许碰。**不要改 `bwrapArgs` 本身**（它是纯函数，第 02a 条刚定下这个设计）。

## 现状

第 02a 条把凭据路径按目录 / 文件分流：目录用 `--tmpfs`，文件用 `--ro-bind <blankFile> <target>`，`blankFile` 是 `bwrapArgs` 的可选参数，**默认 `/dev/null`**（第 377 行、以及函数体里那句 `opts.blankFile ?? "/dev/null"`）。

而第 683 到 690 行 `wrapShellCommand` 调它时**没有传** `blankFile`，所以线上实际用的就是 `/dev/null`。

## 缺陷

02a 当时实测过：用 `--ro-bind /dev/null <文件>` 挂上去之后，沙箱内读那个文件拿到的是**权限拒绝**（`cat: ...: Permission denied`），不是空文件。

安全效果是达到了（读不到凭据内容），但对工具不友好：

- `npm` / `pnpm` 读 `.npmrc` 时遇到 `EACCES` 会**报错退出**，而遇到「文件不存在或为空」则会正常继续；
- `git` 读 `.git-credentials`、`curl` 读 `.netrc` 同理。

也就是说沙箱一开，装依赖这类正常操作可能直接失败，而失败原因看起来跟凭据毫无关系——用户只会觉得「开了沙箱就装不上依赖」。

## 期望语义

**准备一个真实的空文件，作为文件类凭据的覆盖源。**

1. **新增一个导出函数**（放在 `sandboxTempRoots` 附近）：

   ```
   /**
    * 文件类凭据路径的覆盖源：一个真实存在的空文件。
    *
    * 为什么不用 `/dev/null`：以它为源 `--ro-bind` 上去之后，沙箱内读那个路径拿到的是
    * 权限拒绝，而 npm / git / curl 读不到凭据文件时的正常路径是「空或不存在」——
    * 拿到 EACCES 它们会直接报错退出，用户只会觉得「开了沙箱就装不上依赖」。
    *
    * 放在数据目录下、按需创建、失败时退回 `/dev/null`（安全性不受影响，只是没那么友好）。
    */
   export function sandboxBlankFile(): string {
     ...
   }
   ```

   实现要点：

   - 路径用 `getDataDir()` 下的一个固定名字（比如 `sandbox-blank`），**不要**放临时目录——那里可能被系统清理，而沙箱启动时它必须存在；
   - 文件不存在就创建成**零字节**；已存在就直接用（不要每次重写）；
   - 整个过程包 try/catch，**任何失败都返回 `"/dev/null"`** —— 退化回当前行为，绝不能因为建不出文件就让沙箱起不来；
   - 不要把它加进沙箱的可写路径（它必须是只读源）。

2. **第 683 到 690 行**那次 `bwrapArgs(...)` 调用里多传一个 `blankFile: sandboxBlankFile(),`。其余参数原样不动。

## 不要做的事

- 不要改 `bwrapArgs`（纯函数，保持不探测、不碰文件系统）
- 不要改 `sandboxCredentialPaths` / `existingCredentialPaths` 的清单
- 不要改目录类凭据仍走 `--tmpfs` 的分流逻辑
- 不要把这个空文件加进可写路径或授权目录

## 测试要求

往 `apps/studio/src/bun/agent-sandbox.test.ts` 加用例。至少覆盖这 3 条：

1. **`sandboxBlankFile()` 返回的路径真实存在且长度为 0**。
2. **连续调用两次返回同一路径**，且文件没被重写（可以先往里写一个字节、再调一次、断言那个字节还在——证明「已存在就直接用」；断言完自己清理掉）。

   如果你觉得这条会污染别的用例，改成别的等价验证方式也行，但要在汇报里说明。
3. **`wrapShellCommand` 生成的 argv 里，文件类凭据的覆盖源是这个真实空文件、不是 `/dev/null`**。
   照现有那条「argv：凭据**文件**（.npmrc）用 `--ro-bind` 盖住」用例的写法造场景（假 `$HOME` 里放一个 `.npmrc`），断言 `--ro-bind` 后面紧跟的源路径等于 `sandboxBlankFile()` 的返回值。
   （**这条就是本次要修的缺陷，改之前那里是 `/dev/null`**。）

注意：`wrapShellCommand` 只在 Linux + bwrap 可用时才走 bwrap 分支。本机是 Linux 且装了 bubblewrap，可以直接跑；如果用例在别的条件下会被跳过，**不要用 `.skip`**（门禁用了），改成在用例里显式判断并在断言前 `return`，且在汇报里说明。

## 验收标准（汇报第 5 节逐条填）

- [ ] 新函数放在数据目录下、按需创建零字节文件、已存在则复用
- [ ] 任何失败都退回 `/dev/null`
- [ ] `bwrapArgs` 本身没动
- [ ] 凭据清单、目录/文件分流逻辑都没动
- [ ] 空文件没被加进可写路径
- [ ] `wrapShellCommand` 那处传上了 `blankFile`
- [ ] 既有用例全绿
- [ ] 把 `agent-sandbox.ts` 的改动还原后，第 3 条用例会变红（你自己先试一遍）
- [ ] 源码改动不超过 30 行

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/02b-blank-file.json
```

输出原样贴进汇报第 4 节。
