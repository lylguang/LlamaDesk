# 任务 20 返工：删掉订阅还不够，重渲染的根还在 store 里

你的源码改动是对的，保留不动。但**目标没达成**，原因我查出来了，要再补一处。

## 你那条用例为什么是红的

`expect(renders.count - before).toBeLessThanOrEqual(7)` 实测拿到 25——也就是 18 次增量 + 7 次回空，**每一次都 +1**。删掉 `activeMessages` 订阅之后，输入区仍然每次都重渲染。

## 根在哪

`apps/studio/src/mainview/stores/chat.ts` 第 128 到 140 行，`setActiveMessages` 每次都把 `messageStats` **重建成一个新对象**：

```
132        messageStats: Object.fromEntries(
133          Object.entries(state.messageStats).filter(
134            ([id]) => id !== "prototype" && messages.some((m) => String(m.id) === id),
135          ),
136        ),
```

即使一个键都没被过滤掉，出来的也是个新引用。

而 `apps/studio/src/mainview/app/agent/composer-controls.tsx` 第 477 行：

```
477    const stats = useChatStore((s) => s.messageStats);
```

这是 `ContextInspector`，由输入区在第 27 行引入、渲染在它的子树里。于是流式增量每来一个 → `messageStats` 换新引用 → `ContextInspector` 重渲染 → Profiler 计数 +1。

（你跑测试时那条 `An update to ContextInspector inside a test was not wrapped in act(...)` 的警告，就是它。）

`liveStats`（第 137 到 139 行）是同一个毛病，一并处理。

## 要补的改动

**追加允许改动的文件：`apps/studio/src/mainview/stores/chat.ts`** —— 只许改 `setActiveMessages` 这一个 setter。

让它在「没有任何键被过滤掉」时**复用原来的对象**，而不是造个新的。两个字段都要：

- 先算出过滤后的键值对；
- 如果条数等于过滤前的条数，说明一个都没删，直接沿用 `state.messageStats`（`liveStats` 同理）；
- 只有条数变少时才建新对象。

语义完全不变——内容一样，只是不再无谓地换引用。

不要动 `mergeServerMessages`（第 193 行附近那处同样的过滤）：那条路径本来就伴随内容变化，不在这次范围内。也不要动 `ContextInspector` 的选择器。

## 用例改成这样

原来那条的阈值是拍出来的（`≤ 7`），现在根因修掉之后应该是**干净的 0**。把它改成：

- 18 次流式增量期间，`renders.count` 的净增**等于 0**；
- 回空（`setActiveMessages([])`）那几次允许 +1，因为那次是真的有键被过滤掉、`messageStats` 本来就该换引用。

把那些「≤1 的固有抖动」「用相同序列对齐基线」的绕法全部删掉——根因修掉之后不需要它们了。文件里那两段重复粘贴的注释（第 194 到 209 行贴了两遍）也一并清掉。

第二条用例（发送时追加到最新数组）保持不动。

## 自检

改完跑一次，两条用例都要绿，而且第一条里增量期间的净增必须是 0（不是「小于等于某个数」）。把跑出来的计数贴进汇报第 2 节。

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/20-composer-subscription.json
```

输出原样贴进汇报第 4 节。汇报按六节格式写。
