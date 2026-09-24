# 任务 24a 返工：把接线抽成纯函数，让它也能被测到

源码逻辑是对的，别改语义。这轮只做一件事：**把 `useSessionChanges` 里的累计逻辑抽成一个导出的纯函数**，然后给它补用例。

只改这两个文件：
- `apps/studio/src/mainview/app/agent/review-tab.tsx`
- `apps/studio/src/mainview/app/agent/review-apply-patch.test.ts`

## 为什么

我上一轮说「hook 里的接线靠读 diff 保证」，于是验收时定点变异——**把 `review-tab.tsx` 里的 `patchFilePaths` 换成一个永远返回空数组的桩**——4 条用例**全绿**。

这不是你的错（我明确禁止为它搭 happy-dom 脚手架），但结论很清楚：**补丁那条分支一行都没被测到**。而它恰恰是这条任务的主体。

出路不是去搭 DOM 脚手架，而是把那段纯计算从 hook 里挪出来——它本来就不依赖 React。

## 怎么改

在 `review-tab.tsx` 里新增一个导出的纯函数，把 `useSessionChanges` 的 `useMemo` 体整段搬进去：

```
export type SessionChange = { path: string; added: number; removed: number; tool: string };

/**
 * 从 agent 的 tool_start 事件里累计「这一轮改了哪些文件、各自增删多少行」。
 *
 * 纯函数（不依赖 React），便于直接单测——hook 只剩一层 useMemo 包装。
 */
export function collectSessionChanges(
  events: { kind: string; toolName?: string | null; args?: string | null }[],
): SessionChange[] {
  ...原样搬过来...
}
```

`useSessionChanges` 改成：

```
function useSessionChanges() {
  const events = useAgentStore((s) => s.events);
  return useMemo(() => collectSessionChanges(events), [events]);
}
```

**逻辑一行都不许改**：三个工具名的判断、补丁多文件登记、近似口径、那两处 try/catch、`reverse()`，全部照搬。入参类型放宽成上面那个结构就行（别去改 store 的类型）。

## 补用例

给 `collectSessionChanges` 加用例，至少这 5 条：

1. **单文件补丁**：一条 `apply_patch` 的 `tool_start` 事件，补丁只改一个文件；断言结果里那个文件在、增删行数等于补丁里 `+` / `-` 的行数（**准确值，不是近似**）。
2. **多文件补丁**：补丁改三个文件；断言三个文件都在、`tool` 字段是 `"apply_patch"`、增删行数按合计除以 3 向上取整。
3. **`write_file` / `edit_file` 的老路径不变**：各来一条事件，断言文件与增删行数照旧。
4. **坏参数不炸**：`args` 给一段非法 JSON（比如 `"{"`），断言函数正常返回、不抛错。补丁与非补丁两条路径各测一次。
5. **非 `tool_start` 事件、以及别的工具名（比如 `bash`）被跳过**。

第 1 条和第 2 条是这次的主体；第 4 条钉住我补的那两处 try/catch。

## 自检

改完自己做一次变异验证：把函数里的 `patchFilePaths(patch)` 换成 `[]`，**第 1、2 条必须变红**；改回来必须全绿。把两次输出贴进汇报第 2 节。

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/24a-review-tab-apply-patch.json
```

输出原样贴进汇报第 4 节。汇报按六节格式写。
