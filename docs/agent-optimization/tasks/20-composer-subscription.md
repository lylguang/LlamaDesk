# 任务 20：输入区订阅了整份消息数组，每个流式增量都让它整个重渲染

工作树根目录：`/home/xixi/Git/OmniStudio/.claude/worktrees/agent-optimize`

## 允许改动的文件（只有这两个）

1. `apps/studio/src/mainview/app/agent/composer.tsx` —— 源码，只许改第 286 行和第 493 到 496 行这两处
2. `apps/studio/src/mainview/app/agent/composer-render.test.tsx` —— 你要新建的测试文件（现在不存在）

别的文件一个都不许碰。**不要动 `composer-slash.test.tsx` 和 `composer-workspace.test.tsx`**，它们是现成的参考，只读不改。

## 现状

`apps/studio/src/mainview/app/agent/composer.tsx` 第 286 行：

```
286    const activeMessages = useChatStore((s) => s.activeMessages);
```

这个值在整个 789 行的组件里**只有一处用到**，就是第 493 到 496 行发送时往数组尾部追加一条：

```
492      const now = Date.now();
493      useChatStore.getState().setActiveMessages([
494        ...activeMessages,
495        { id: now, conversationId, role: "user", content, images, createdAt: now },
496      ]);
```

## 缺陷

`activeMessages` 是会话里的全部消息。模型流式输出时，**每来一个增量**这个数组就会被换成新的（最后一条消息的 `content` 在变），于是第 286 行这个订阅每次都触发——**整个输入区跟着重渲染**。

输入区不是个小组件：789 行，里面有附件列表、斜杠命令补全面板、工作区选择、模型选择、一排按钮。一秒几十个增量，它就跟着重渲染几十次。而它**根本不显示消息内容**，这些重渲染一次都不需要。

注意第 493 行自己已经在用 `useChatStore.getState()` 了——同一个函数里，一边用 `getState()` 拿 store 去写，一边又靠订阅拿同一个 store 的值去读。读那一路完全可以照着写那一路来。

## 期望语义

**删掉第 286 行那个订阅**，第 494 行改成发送那一刻现取：

```
      const current = useChatStore.getState().activeMessages;
```

然后用 `current` 拼数组。

这样语义完全不变——发送时拿到的仍然是当时最新的数组，而且比订阅**更准**：订阅拿到的是上一次渲染时的快照，现取拿到的是此刻的值。

别的一律不动：`setActiveMessages`、`setStreaming`、`setRunning`、`sendMutation` 的调用顺序都保持原样。

## 测试要求

新建 `apps/studio/src/mainview/app/agent/composer-render.test.tsx`。

**测试脚手架照抄 `apps/studio/src/mainview/app/agent/composer-slash.test.tsx` 的第 1 到 101 行**（happy-dom 全局注入、`mock.module("@lib/rpc", ...)` 那个 Proxy、`afterAll` / `afterEach` 清理），再照抄它渲染组件的写法。

数重渲染次数用 React 自带的 `Profiler`：

```
const { Profiler } = await import("react");
let renders = 0;
// 渲染时把组件包在 Profiler 里
createElement(Profiler, { id: "composer", onRender: () => { renders += 1; } }, createElement(AgentComposer, props))
```

`onRender` 每次子树重渲染都会调一次，用它计数最直接。

至少覆盖这 2 条：

1. **流式增量不再让输入区重渲染**：先渲染好、记下当前的 `renders`；然后在 `act` 里调若干次 `useChatStore.getState().setActiveMessages([...])`（每次给一个内容不同的新数组，模拟流式增量）；断言 `renders` **没有增加**。
   （**这条就是本次要修的缺陷，改之前每次 setActiveMessages 都会让它加一**。）
2. **发送时仍然把新消息追加到当时最新的数组上**：先往 store 里放两条已有消息，然后走一遍发送（输入文字 + 点发送按钮，照抄 `composer-slash.test.tsx` 里的 `type` 和 `clickSend` 辅助函数），断言 `setActiveMessages` 之后 store 里是 3 条、且最后一条是刚发的那条。这条是防止改过头把追加逻辑弄丢。

如果 `Profiler` 在这套 happy-dom 环境里不好使，或者渲染组件缺的 mock 太多，**不要硬凑**，在汇报第 6 节写清卡在哪，我来决定怎么办。

## 验收标准（汇报第 5 节逐条填）

- [ ] 第 286 行那个订阅已删除
- [ ] 发送时改用 `getState()` 现取
- [ ] 追加逻辑与调用顺序没变
- [ ] 组件里没有别处再引用 `activeMessages`（自己 grep 一遍确认）
- [ ] 没有动另外两个 composer 测试文件
- [ ] 把 `composer.tsx` 的改动还原后，第 1 条用例会变红（你自己先试一遍）
- [ ] 源码改动不超过 10 行

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/20-composer-subscription.json
```

输出原样贴进汇报第 4 节。
