# 任务 23：Agent 会话无条件贴底，流式输出时根本没法往上翻

工作树根目录：`/home/xixi/Git/OmniStudio/.claude/worktrees/agent-optimize`

## 允许改动的文件（只有这三个）

1. `apps/studio/src/mainview/app/agent/use-follow-scroll.ts` —— 你要新建的 hook 文件
2. `apps/studio/src/mainview/app/agent/conversation.tsx` —— 只许改自动滚动那一段和滚动容器那一行
3. `apps/studio/src/mainview/app/agent/use-follow-scroll.test.ts` —— 你要新建的测试文件

别的文件一个都不许碰。**特别注意：不要动 `app/chat/index.tsx`**，那是对话页、现在工作正常，这次不动它。

## 现状

`apps/studio/src/mainview/app/agent/conversation.tsx` 第 157 到 163 行：

```
157    // 新消息 / 新事件进来时贴到底。这里用 scrollTop 直接赋值而不是 scrollIntoView：
158    // 后者会连带把外层容器也滚一下，工具条会跳。
159    const lastForScroll = activeMessages[activeMessages.length - 1];
160    useEffect(() => {
161      const el = scrollRef.current;
162      if (el) el.scrollTop = el.scrollHeight;
163    }, [activeMessages.length, lastForScroll?.content, lastForScroll?.reasoning, events.length]);
```

滚动容器在第 243 行：`<div ref={scrollRef} className="thread-scroll">`，**没有 onScroll**。

## 缺陷

只要正文或事件有变化，就无条件把视口拽回底部。

模型流式输出时，正文每来一个增量就触发一次。用户想往上翻看刚才那段代码、或者回看某次工具调用的输出——**手一松就被拽回底部**，一秒几十次，等于翻不了。

对话页早就解决了这个问题。`apps/studio/src/mainview/app/chat/index.tsx` 第 82 到 93 行有完整的跟随模式，注释原话：

```
82    // 跟随模式：没往上翻就跟着新内容贴底；翻上去了就别抢用户的滚动条
83    // （本地模型一边出字一边把视口拽回底部，是"想回看上一段"时最烦人的一件事）。
```

判据在第 90 行：

```
90      const following = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD_PX;
```

`FOLLOW_THRESHOLD_PX = 64`（第 31 行）。

Agent 页恰恰是工具输出最多、最需要回看的页面，却没有这个保护。

## 期望语义

**新建一个 hook 文件** `apps/studio/src/mainview/app/agent/use-follow-scroll.ts`，把「跟随模式」做成可复用的一份：

```
/** 距底多少像素以内算「还在跟着看」。与对话页同一口径。 */
export const FOLLOW_THRESHOLD_PX = 64;

/** 纯函数：根据滚动位置判断是不是还在跟随。抽出来是为了能直接单测。 */
export function isFollowing(el: { scrollHeight: number; scrollTop: number; clientHeight: number }): boolean {
  ...
}
```

再导出一个 hook（名字用 `useFollowScroll`），职责：

- 内部用 `useRef` 记「当前是否跟随」，初值 `true`；
- 返回一个 `onScroll` 处理函数：每次滚动用 `isFollowing` 更新那个 ref；
- 返回一个 `scrollToBottomIfFollowing` 函数：跟随时才把 `scrollTop` 设成 `scrollHeight`，不跟随时什么都不做。

hook 接受滚动容器的 ref 作为参数。

然后在 `conversation.tsx` 里：

- 第 160 到 163 行那个 effect 改成调用 `scrollToBottomIfFollowing()`，依赖数组**保持原样不动**；
- 第 243 行的滚动容器加上 `onScroll={...}`；
- 第 157、158 两行原注释保留（`scrollTop` 直接赋值而不用 `scrollIntoView` 的理由仍然成立），在后面补一句说明跟随模式。

**不要**加「回到底部」按钮，那是界面改动，这次不做。用户滚回到距底 64 像素以内时，跟随会自己恢复。

## 为什么把 `isFollowing` 单独抽出来

hook 本身要 DOM 环境才测得动，而这条的核心判据就是那个算式。把它抽成纯函数，就能直接拿几组数字断言，不用搭 happy-dom。这是这次唯一要求写测试的部分。

## 测试要求

新建 `apps/studio/src/mainview/app/agent/use-follow-scroll.test.ts`（注意是 `.ts` 不是 `.tsx`，不需要 DOM）。

只测 `isFollowing`，至少覆盖这 4 条：

1. **正好贴底**（`scrollTop + clientHeight === scrollHeight`）→ 跟随。
2. **距底 63 像素**（阈值内）→ 跟随。
3. **距底 64 像素**（正好等于阈值）→ **不跟随**（判据是严格小于）。
4. **距底很远**（比如 500 像素）→ 不跟随。

另外补一条：**内容不足一屏时**（`scrollHeight === clientHeight`，`scrollTop` 为 0）→ 跟随。这条容易被写漏，而它是最常见的初始状态。

## 验收标准（汇报第 5 节逐条填）

- [ ] `isFollowing` 是纯函数，导出了，不依赖 DOM 类型
- [ ] 阈值用的是 64，判据是严格小于
- [ ] hook 在不跟随时**不**动 `scrollTop`
- [ ] `conversation.tsx` 的依赖数组没动
- [ ] 滚动容器接上了 `onScroll`
- [ ] 第 157、158 行原注释保留
- [ ] 没有动 `app/chat/index.tsx`
- [ ] 没有加「回到底部」按钮
- [ ] 源码改动（两个文件合计）不超过 45 行

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/23-follow-scroll.json
```

输出原样贴进汇报第 4 节。
