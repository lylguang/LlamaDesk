# 任务 24b：每条消息都挂着两个确认弹窗，关着也要跑一遍组件

工作树根目录：`/home/xixi/Git/OmniStudio/.claude/worktrees/agent-optimize`

## 允许改动的文件（只有这一个）

`apps/studio/src/mainview/app/agent/message.tsx` —— 只许改 `useMessageActions` 里构造那两个弹窗的地方（第 413 到 443 行）。

别的文件一个都不许碰。**这次不要求写新测试**（是纯粹的懒构造，行为零变化），验收靠现有用例全绿加读 diff。

## 现状

`useMessageActions`（第 228 行起）每条消息都会构造两个确认弹窗：

```
413    // 「撤销本轮」要先预览再执行：确认弹窗在这里构造，由调用方渲染一次（操作条里）。
414    const revertDialog =
415      isAssistant && snapshot ? (
416        <RevertTurnDialog open={revertOpen} ... />
417      ) : null;
...
429    // 「回退对话到这里」：同样先确认再执行（它删的是历史，撤销不回来）。
430    const conversationRevertDialog = (
431      <ConversationRevertDialog open={conversationRevertOpen} ... />
432    );
```

第 487 到 488 行由操作条渲染它们。

`RevertTurnDialog` 已经带了条件（只有助手消息且有快照才构造），但 `ConversationRevertDialog` 是**无条件**的。

## 缺陷

`open={false}` 时弹窗不显示，但**组件本身仍然会被渲染一遍**——它的 hook 会跑、内部的 `useMutation` 会建、条件分支会算。一个长会话有几十上百条消息，就有几十上百个这样的空载弹窗组件挂在树上，每次列表重渲染它们都要跟着跑一遍。

它们真正有用的时刻只有一个：用户点了那条菜单项、把 `open` 置成 true 之后。

## 期望语义

**两个弹窗都改成「开着才构造」。**

- `conversationRevertDialog`：在现有表达式外面再加一层条件，`conversationRevertOpen` 为 false 时给 `null`。
- `revertDialog`：现有条件 `isAssistant && snapshot` 之外再加上 `revertOpen`。

两处的 props、回调、`onReverted` 里的那些 `invalidateQueries` 全部原样不动。

**为什么这样是安全的**：这两个弹窗的「打开」由同一个组件里的 `revertOpen` / `conversationRevertOpen` 两个 state 控制（第 244 到 245 行）。state 从 false 变 true 会触发重渲染，那时弹窗才被构造出来并以 `open={true}` 挂载——和现在「一直挂着、靠 prop 切换」的最终结果一致。

**唯一要留意的**：某些弹窗库靠「挂载时 open=false → 之后变 true」来跑进场动画。这两个用的是项目里共用的 `Dialog`（`components/ui/dialog.tsx`，Radix 封装），它的进出场由 Radix 自己按 `open` 管理，直接以 `open={true}` 挂载同样会播放进场动画。如果你在自检时发现动画或焦点行为有异常，**停下来在汇报第 6 节说明，不要硬改**。

## 不要做的事

- 不要改这两个弹窗组件本身（`revert-dialog.tsx` / `conversation-revert-dialog.tsx`）
- 不要动那三个 `useMutation`（第 256、264、279 行）——hook 不能写在条件里，那是另一件事
- 不要动操作条的渲染位置（第 487 到 488 行）
- 不要改菜单项、回调、`invalidateQueries` 的任何参数

## 自检

1. `bun run test`（工作树根目录）全量必须仍然全绿——`message.test.tsx` 有 20 条用例覆盖这个组件，它们是这次的主要证据。
2. 自己读一遍 diff，确认**只有条件表达式变了**，props 与回调一个字没动。

## 验收标准（汇报第 5 节逐条填）

- [ ] 两个弹窗都改成「开着才构造」
- [ ] props、回调、`invalidateQueries` 参数一字未动
- [ ] 三个 `useMutation` 没动
- [ ] 两个弹窗组件文件没动
- [ ] 操作条渲染位置没动
- [ ] 全量测试全绿
- [ ] 源码改动不超过 10 行

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/24b-lazy-dialogs.json
```

输出原样贴进汇报第 4 节。
