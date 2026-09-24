# 任务 22：打开会话时轨迹事件被全量加载两次

工作树根目录：`/home/xixi/Git/OmniStudio/.claude/worktrees/agent-optimize`

## 允许改动的文件（只有这两个）

1. `apps/studio/src/mainview/app/agent/conversation.tsx` —— 源码，只许改那个「追平」的 `useEffect`
2. `apps/studio/src/mainview/app/agent/conversation.test.tsx` —— 你要新建的测试文件（现在不存在）

别的文件一个都不许碰。

## 现状

`apps/studio/src/mainview/app/agent/conversation.tsx` 第 52 到 58 行，打开会话时拉一次全量轨迹：

```
52    const eventsQuery = useQuery({
53      queryKey: ["agent-events", conversationId],
54      queryFn: () => rpcClient.listAgentEvents({ conversationId }),
55    });
56    useEffect(() => {
57      if (eventsQuery.data) useAgentStore.getState().setEvents(eventsQuery.data.events);
58    }, [eventsQuery.data]);
```

第 211 到 228 行，另有一个「追平」的 effect，防止推送丢事件：

```
211    useEffect(() => {
212      const catchUp = async () => {
213        const known = useAgentStore.getState().events;
214        const afterId = known.length > 0 ? known[known.length - 1]!.id : 0;
215        try {
216          const data = await rpcClient.listAgentEvents({ conversationId, afterId });
217          if (data.events.length > 0) useAgentStore.getState().mergeEvents(data.events);
218        } catch {
219          // 追平失败不影响这一屏：下一次 tick / 下一次打开会话会再对齐
220        }
221      };
222      if (!running) {
223        void catchUp();
224        return;
225      }
226      const timer = window.setInterval(() => void catchUp(), 4000);
227      return () => window.clearInterval(timer);
228    }, [running, conversationId]);
```

## 缺陷

刚打开会话那一刻，store 里还没有事件（第 52 行那个查询还在飞）。于是第 214 行算出 `afterId = 0`，第 216 行发出的这次请求**等于又一次全量拉取**。

结果：打开一个有几千条轨迹事件的会话，同样的数据**被完整拉两遍**——一遍来自 `eventsQuery`，一遍来自本该只拉增量的追平。会话越长越明显。

第 209 行的注释写的是「正常情况下每次返回空数组，几乎不花钱」——这句只在**已经有事件之后**成立，打开的第一下恰恰不成立。

## 期望语义

追平要等首次全量落地之后再开始。

把第 211 行那个 effect 改成：`eventsQuery` 成功之前直接返回，什么都不做；成功之后再按现在的逻辑跑（不在跑就追平一次，在跑就每 4 秒一次）。

依赖数组里要把这个「首次是否已成功」的标志加进去，否则成功之后 effect 不会重跑。

`afterId` 的算法**不要动**：真的是空会话时从 0 追平是对的，也很便宜。要挡掉的是「首次全量还没回来就先发一次全量」。

其余一律不动：`eventsQuery` 本身、`setEvents` / `mergeEvents`、4 秒间隔、`catch` 里那段注释、清理定时器的逻辑。

## 测试要求

新建 `apps/studio/src/mainview/app/agent/conversation.test.tsx`。

**测试脚手架照抄 `apps/studio/src/mainview/app/agent/composer-slash.test.tsx` 的第 1 到 101 行**（happy-dom 的全局注入、`mock.module("@lib/rpc", ...)` 那个记录调用的 Proxy、`afterAll` / `afterEach` 清理）。那份 Proxy 会把每次 RPC 调用记进 `calls` 数组，正好用来数请求次数。

需要补的 mock 返回值：`listAgentEvents` 返回 `{ events: [] }`，其它按你渲染时报错的提示补（缺什么补什么，都返回最简单的空结构即可）。

导入的组件换成会话组件本身；渲染方式照抄那份测试里 `createRoot` + `act` 的写法。

至少覆盖这 2 条：

1. **打开会话后，不带 `afterId`（或 `afterId` 为 0）的全量请求只发生一次**（**这条就是本次要修的缺陷，改之前会是两次**）。
   数法：从 `calls` 里筛出 `method === "listAgentEvents"` 的记录，统计 `params.afterId` 为 `undefined` 或 `0` 的条数，断言等于 1。
2. **首次加载完成之后，追平仍然会发生**：等首次查询落地后触发一次追平，断言确实又发出了 `listAgentEvents`（这次带着 `afterId`）。这条是防止改过头把追平整个关掉。

如果渲染这个组件需要的 mock 太多、搭不起来，**不要硬凑**，在汇报第 6 节写清卡在哪、缺哪些 mock，我来决定怎么办。

## 验收标准（汇报第 5 节逐条填）

- [ ] 首次全量落地之前不发追平请求
- [ ] 落地之后追平照常工作（含 4 秒轮询那条路）
- [ ] `afterId` 的算法没动
- [ ] `eventsQuery` / `setEvents` / `mergeEvents` / 间隔 / 清理逻辑都没动
- [ ] 新测试文件能跑，且不依赖真实网络
- [ ] 把 `conversation.tsx` 的改动还原后，第 1 条用例会变红（你自己先试一遍）
- [ ] 源码改动不超过 15 行

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/22-events-double-load.json
```

输出原样贴进汇报第 4 节。
