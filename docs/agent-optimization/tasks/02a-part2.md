# 任务 02a 续：测试已经写好了，现在只改源码

上一轮你把测试写完了，写得对，**一个字都不要再动**。你这轮只做一件事：改源码让它们变绿。

只许改这一个文件：`apps/studio/src/bun/agent-sandbox.ts`
（`agent-sandbox.test.ts` 这轮**不许碰**。）

## 当前状态

测试文件已有 42 条用例，其中你新加的 3 条里有 2 条是红的：

```
(fail) Linux（bwrap） > argv：凭据**文件**（.npmrc）用 --ro-bind 盖住，而不是 --tmpfs
(fail) Linux（bwrap） > argv：blankFile 可自定义文件类凭据的覆盖源，缺省是 /dev/null
 36 pass  2 fail
```

typecheck 也是红的，只有一条错：

```
src/bun/agent-sandbox.test.ts(316,9): error TS2353: Object literal may only specify
known properties, and 'blankFile' does not exist in type '{ workspace: string; ... }'
```

## 就改两处

**第一处：`bwrapArgs` 的参数类型（第 370 到 377 行）**，加一个可选字段：

```
export function bwrapArgs(opts: {
  workspace: string;
  shell: string;
  command: string;
  mode?: SandboxMode;
  authorizedFolders?: string[];
  allowNetwork?: boolean;
  blankFile?: string;        // ← 加这一行
}): string[] {
```

**第二处：挂凭据路径那一段（第 391 到 394 行）**，现在是：

```
391      // 凭据目录挖空：bwrap 没有"按路径拒绝读"的写法，用空的 tmpfs 盖住最直接。
392      for (const target of existingCredentialPaths()) {
393        args.push("--tmpfs", target);
394      }
```

改成：目录仍然 `--tmpfs`，文件改成 `--ro-bind <blankFile> <target>`，`blankFile` 取 `opts.blankFile ?? "/dev/null"`。

判断用 `statSync(target).isDirectory()`，**包在 try/catch 里**：取不到状态就当文件处理走 `--ro-bind`（保守，总比让沙箱起不来强）。

`statSync` 要确认文件顶部已经 import 了；没有就从 `fs` 补上。

把第 391 行那句注释也更新一下，说清为什么文件不能用 tmpfs（对着普通文件挂 tmpfs，bwrap 会直接启动失败，报 `Can't mkdir ...: Not a directory`）。

## 不要做的事

- 不要动 `sandboxCredentialPaths()` 的清单内容
- 不要动 `existingCredentialPaths()`
- 不要动 `wrapShellCommand`
- 不要动 `agent-sandbox.test.ts`
- 不要顺手改别的地方

## 验收标准（汇报第 5 节逐条填）

- [ ] `blankFile` 加成了可选参数，默认 `/dev/null`
- [ ] 文件类凭据走 `--ro-bind`，目录类仍走 `--tmpfs`
- [ ] `statSync` 包了 try/catch，异常时按文件处理
- [ ] `bwrapArgs` 仍是纯函数（除了 `statSync` 这次必要的判断，没有新增读设置或起进程）
- [ ] 上面列的「不要做的事」一条都没做
- [ ] typecheck 由红转绿
- [ ] 那 2 条红用例转绿，其余 40 条仍绿
- [ ] 源码改动不超过 30 行

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/02a-bwrap-cred-files.json
```

输出原样贴进汇报第 4 节。

汇报按规则里的六节格式写，但第 2 节「先红后绿」这轮只要贴「改之前的红」和「改之后的绿」两次输出就行——红的输出上面已经给你了，直接用。
