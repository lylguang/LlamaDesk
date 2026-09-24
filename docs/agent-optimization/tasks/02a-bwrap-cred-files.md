# 任务 02a：凭据路径里的「文件」不能用 `--tmpfs`，会让整个沙箱起不来

工作树根目录：`/home/xixi/Git/OmniStudio/.claude/worktrees/agent-optimize`

## 允许改动的文件（只有这两个）

1. `apps/studio/src/bun/agent-sandbox.ts` —— 源码，只许改 `bwrapArgs` 里挂凭据路径那一段
2. `apps/studio/src/bun/agent-sandbox.test.ts` —— 既有测试文件，**只许往里加用例，一条现有用例都不许删、不许改**

别的文件一个都不许碰。

## 现状

`apps/studio/src/bun/agent-sandbox.ts` 第 391 到 394 行：

```
391      // 凭据目录挖空：bwrap 没有"按路径拒绝读"的写法，用空的 tmpfs 盖住最直接。
392      for (const target of existingCredentialPaths()) {
393        args.push("--tmpfs", target);
394      }
```

`existingCredentialPaths()`（第 355 行）返回 `sandboxCredentialPaths()` 里真实存在的那些路径。而 `sandboxCredentialPaths()`（第 406 行起）这份清单里，**有目录也有文件**：

- 目录：`.ssh`、`.aws`、`.gnupg`、`.kube`、`.codex`、`.claude`、`.omni`、`Library/Keychains`
- **文件**：`.netrc`、`.npmrc`、`.git-credentials`（第 412 到 414 行）

## 缺陷

`--tmpfs` 是挂一个 tmpfs 文件系统到挂载点上，挂载点必须是**目录**。对着一个普通文件用 `--tmpfs`，bwrap 直接启动失败。

本机实测（bubblewrap 0.9.0）：

```
$ bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp/xxx/.npmrc /bin/true
bwrap: Can't mkdir /tmp/xxx/.npmrc: Not a directory
退出码 1
```

后果很重：用户家目录里只要有 `.npmrc`（很常见），沙箱一开，**所有命令都跑不了**。而且失败信息会被当成「沙箱拦截」，引导用户去点「跳过沙箱重试」——等于把沙箱劝退了。

## 期望语义

挂凭据路径时区分目录和文件：

- **目录**：继续用 `--tmpfs <目录>`，行为完全不变。
- **文件**：改用 `--ro-bind <blankFile> <文件>`，把一个空内容的东西只读绑到它上面，盖住原内容。

给 `bwrapArgs` 的参数对象加一个**可选**字段 `blankFile?: string`，默认值 `"/dev/null"`。这样函数还是纯函数（不探测、不读设置、不碰文件系统），跟它现在的设计说明一致。

本机实测这么挂 bwrap 能正常启动，且沙箱内读那个文件拿不到原内容：

```
$ bwrap --ro-bind / / --dev /dev --proc /proc --ro-bind /dev/null /tmp/xxx/.npmrc /bin/cat /tmp/xxx/.npmrc
cat: /tmp/xxx/.npmrc: Permission denied
退出码 1（bwrap 本身启动成功）
```

判断目录还是文件，用 `statSync(target).isDirectory()`。取不到状态（比如竞态下被删了）就当文件处理，按 `--ro-bind` 走——保守一些，总比让沙箱起不来强。

**不要动** `sandboxCredentialPaths()` 的清单内容，也**不要动** `existingCredentialPaths()`。
**不要动** `wrapShellCommand`。把默认值换成真实空文件是另一条任务，这次不做。

## 测试要求

往 `apps/studio/src/bun/agent-sandbox.test.ts` 的 `describe("Linux（bwrap）", ...)` 里加用例。

现有那条「argv：凭据目录用空 tmpfs 盖住」（第 232 行）用的是假的 `$HOME` 加一个 `.ssh` **目录**，所以一直没暴露这个问题。照它的写法搭场景：临时目录冒充 `$HOME`，里面**同时**建一个 `.ssh` 目录和一个 `.npmrc` 文件。

至少覆盖这 3 条：

1. `.npmrc` 这种文件出现在 `--ro-bind` 的参数里，**不出现在** `--tmpfs` 的参数里（**这条就是本次要修的缺陷，改之前必须是红的**）
2. `.ssh` 这种目录仍然走 `--tmpfs`，没被改成 `--ro-bind`
3. 传了自定义 `blankFile` 时，文件类凭据绑的是这个自定义路径；不传时绑的是 `/dev/null`

断言要针对 argv 里的具体配对关系（哪个参数跟在哪个开关后面），不要只断言「数组里包含某个字符串」——`--ro-bind` 在 argv 里出现很多次，光看包含关系分不出是哪一对。

## 验收标准（汇报第 5 节逐条填）

- [ ] 文件类凭据路径改用 `--ro-bind`，目录类仍用 `--tmpfs`
- [ ] `blankFile` 是可选参数，默认 `/dev/null`
- [ ] `bwrapArgs` 仍然是纯函数，没有新增读设置或探测
- [ ] 没有动 `sandboxCredentialPaths` 的清单，没有动 `existingCredentialPaths`，没有动 `wrapShellCommand`
- [ ] 既有测试用例一条没删、没改，数量只增不减
- [ ] 新加的 3 条用例断言的是 argv 里的配对关系，不是单纯的包含关系
- [ ] 把 `agent-sandbox.ts` 的改动还原后，第 1 条用例会变红（你自己先试一遍）
- [ ] 源码改动行数不超过 30 行

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/02a-bwrap-cred-files.json
```

输出原样贴进汇报第 4 节。出现 `RESULT FAIL` 就是没做完。
