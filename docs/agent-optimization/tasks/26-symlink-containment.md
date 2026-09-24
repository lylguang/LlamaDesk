# 任务 26：工作区归属判定不解软链，区内软链指向区外可绕过三道门

工作树根目录：`/home/xixi/Git/OmniStudio/.claude/worktrees/agent-optimize`

## 允许改动的文件（只有这两个）

1. `apps/studio/src/bun/agent-tools.ts` —— 源码，只许新增一个内部辅助函数，并改 `assertNotSecret`、`assertInsideWorkspace`、`assertReadable`、`assertWritable` 这四个函数里做「在不在工作区里」判断的那几行
2. `apps/studio/src/bun/agent-tools.path.test.ts` —— 你要新建的测试文件（现在不存在）

别的文件一个都不许碰。特别注意：**不要动 `agent-spill.ts`**，**不要动 `SECRET_PATH_PATTERNS` 的清单内容**，**不要动 `authorizedFoldersOf`**。

## 现状

`apps/studio/src/bun/agent-tools.ts` 里，四处「在不在工作区里」的判断全是**字符串前缀比较**：

```
222  function assertNotSecret(workspace: string, target: string): void {
223    const root = path.resolve(workspace);
224    if (target === root || target.startsWith(root + path.sep)) return;
...
239  export function assertInsideWorkspace(workspace: string, target: string) {
240    const root = path.resolve(workspace);
241    if (target !== root && !target.startsWith(root + path.sep)) {
...
275  export function assertReadable(ctx: ToolContext, target: string): void {
276    const root = path.resolve(ctx.workspace);
277    const abs = path.resolve(target);
278    if (abs === root || abs.startsWith(root + path.sep)) return;
...
288  export function assertWritable(ctx: ToolContext, target: string): void {
289    const root = path.resolve(ctx.workspace);
290    const abs = path.resolve(target);
291    if (abs === root || abs.startsWith(root + path.sep)) return;
```

`path.resolve` 只做字面归一（去掉 `..`、拼成绝对路径），**不解软链接**。

## 缺陷

工作区里放一个指向区外的软链接，字面路径仍然在工作区底下，于是这四处判断全部认为「在区内」：

- `assertNotSecret` 第 224 行直接 return，**凭据黑名单整个跳过**；
- `assertReadable` 第 278 行直接 return，**工作区外读取的授权弹窗跳过**；
- `assertWritable` 第 291 行直接 return，**工作区外写入的限制跳过**。

而这个软链**用 bash 工具自己就能建**——agent 有 shell 权限，建一个软链是一条命令的事。

这不是理论推演：同一个仓库的 `apps/studio/src/bun/agent-spill.ts` 第 76 到 79 行已经把这条攻击路径写清楚了，原话是：

> 判定必须**解开软链接**：`tool-output/<会话>/x` 若是个指向 `~/.ssh/id_rsa` 的软链，光看字面路径会放行 —— 于是凭据拦截、工具结果凭据检查、工作区外读取授权三道门一起被绕过（bash 工具自己就能建这个软链）。

也就是说转存目录那一处已经按真实路径判了，**工作区这四处却漏掉了**。

## 期望语义

新增一个内部辅助函数，把「解开软链之后再判在不在某个根目录底下」这件事统一起来。算法照抄 `agent-spill.ts` 第 85 到 99 行那套（已经在用、已有测试）：

```
/**
 * 解开软链之后判断 target 是不是在 root 底下。
 *
 * 必须解软链：工作区里放一个指向区外的软链，字面路径仍在区内，凭据黑名单与
 * 区外授权会一起被跳过，而 bash 工具自己就能建这个软链。
 * （`agent-spill.ts` 的 isSpillPath 对转存目录用的是同一套判据。）
 */
function isReallyUnder(root: string, target: string): boolean {
  ...
}
```

要点（逐条照做）：

- 先把 `root` 和 `target` 各自 `path.resolve`。
- 字面上就不在 `root` 底下 → 直接 `false`（省掉一次磁盘操作）。
- `root` 不存在 → `false`。
- `root` 取 `realpathSync`。
- `target` 可能还不存在（`write_file` 写新文件）：沿父目录往上找，直到找到第一个存在的祖先；一路找到文件系统根还不存在就 `false`。
- 对那个存在的祖先取 `realpathSync`，判断它等于真实 root 或在真实 root 底下。
- 整段包 try/catch，抛错就 `false`（保守：判不出来就当不在区内，走授权流程）。

`realpathSync` 要从 `fs` 导入（第 1 行那个 import 里加上）。

然后把上面四处的字面前缀判断换成调用它：

- `assertNotSecret` 第 224 行
- `assertInsideWorkspace` 第 241 行
- `assertReadable` 第 278 行
- `assertWritable` 第 291 行

**其余逻辑一律不动**：`isSpillPath` 的那个口子、`underAny` 的已授权目录判断、报错文案、`SECRET_PATH_PATTERNS` 的内容、`resolvePath` 里的 `~` 展开，全都保持原样。

`underAny`（第 261 行，判已授权目录）这次**不要改**——已授权目录是用户明确点过头的，语义和工作区不同，放到另一条任务里单独评估。

## 测试要求

新建 `apps/studio/src/bun/agent-tools.path.test.ts`。照 `agent-tools.patch.test.ts` 开头第 1 到 38 行的写法搭架子（临时工作区、`ToolContext`）。用 `fs` 的 `symlinkSync` 建软链。

至少覆盖这 4 条：

1. **工作区内指向区外凭据目录的软链，读取被拒**：在临时工作区里建一个软链 `ws/leak` 指向一个临时的「假凭据目录」（比如另建一个临时目录，里面放个文件），断言 `assertReadable` 抛错。
   （**这条就是本次要修的缺陷，改之前不会抛错**。）
2. **工作区内指向区外的软链，写入被拒**：同样的软链，断言 `assertWritable` 抛错。
3. **工作区内的普通文件与目录照常放行**（防止改过头）：真实位于工作区里的文件，`assertReadable` / `assertWritable` 都不抛错。
4. **还不存在的新文件路径照常放行**：工作区里一个尚未创建的路径，`assertWritable` 不抛错（写新文件是常规操作，不能因为「路径不存在」就拒掉）。

注意：第 1、2 条里「假凭据目录」不要真用 `~/.ssh`，用临时目录模拟即可——要验证的是**区内软链指向区外时会不会被当成区内**，不是黑名单本身。

## 验收标准（汇报第 5 节逐条填）

- [ ] 四处判断都换成了解软链的版本
- [ ] 不存在的路径沿父目录往上找到第一个存在的祖先
- [ ] 异常时保守判为「不在区内」
- [ ] `underAny` / `isSpillPath` / 报错文案 / 黑名单内容 / `~` 展开都没动
- [ ] 工作区内的普通读写没有被误拦
- [ ] 写新文件（路径尚不存在）没有被误拦
- [ ] 把 `agent-tools.ts` 的改动还原后，第 1 条用例会变红（你自己先试一遍）
- [ ] 源码改动不超过 40 行

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/26-symlink-containment.json
```

输出原样贴进汇报第 4 节。
