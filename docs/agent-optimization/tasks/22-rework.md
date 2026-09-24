# 任务 22 返工：空会话会彻底失去追平能力

先回答你第 6 节的两个问题，再说要改的地方。

## 回答你的问题

**1. 用例 2 不用补 4 秒轮询那一条。** 你的判断对：两条路径调的是同一个 `catchUp`，为了卡 4 秒边界把测试拉长不划算，门确实有 60 秒的慢用例守卫。保持现状。

**2. `afterId` 那句我说得不够准，你的理解没错**——「不要动算法」指的是「有事件时取最后一条 id」这个规则，不是那行字面。但你选的落点有个副作用，就是下面这个。

## 问题：空会话再也不会追平了

你的写法是「`known.length === 0` 就直接 return」。这挡住了首次的重复全量，但也顺手把**另一条正当路径**关掉了：

- 新建一个会话，store 里一条事件都没有；
- `eventsQuery` 回来也是空数组，`known` 仍然是 0 → 追平直接 return；
- Agent 跑起来，4 秒轮询每次进来都是 `known.length === 0` → 每次都 return，**一次请求都不发**；
- 这时候要是第一条事件的推送丢了，它就再也补不回来了——只能等用户重开会话。

而「推送会丢」正是这个 effect 存在的唯一理由，**新建会话又是 Agent 最常见的场景**。等于在最常用的路径上把这道保险拆了。

## 改法

判断条件从「store 里有没有事件」换成「首次全量查询有没有落地」：

```
  useEffect(() => {
    if (!eventsQuery.isSuccess) return;
    const catchUp = async () => {
      const known = useAgentStore.getState().events;
      const afterId = known.length > 0 ? known[known.length - 1]!.id : 0;
      ...原样...
    };
    ...原样...
  }, [running, conversationId, eventsQuery.isSuccess]);
```

三点说明：

- `afterId` 那行**恢复成原来的写法**（空时取 0）。空会话从 0 追平是对的，返回的就是个空数组，很便宜。
- 依赖数组里用 `eventsQuery.isSuccess` 而不是 `eventsQuery.data`：`isSuccess` 从 false 变 true 只发生一次，effect 只多跑一次；`data` 每次查询返回新对象引用都可能让 effect 重跑。
- 不会再出现重复全量：`setEvents` 那个 effect 声明在第 56 行、追平在第 211 行，同一次提交里按声明顺序跑，`setEvents` 先执行，所以追平拿到的 `known` 已经是填好的，算出的是真正的增量 id。

注释也跟着改准确：现在写的是「store 里还没有已知事件时直接返回」，要改成「首次全量查询落地之前不追平」。

## 补一条用例

**空会话也能追平**：让 `listAgentEvents` 返回 `{ events: [] }`，渲染后等首次查询落地，断言随后**确实发出了**一次 `listAgentEvents`（`afterId` 为 0）。

注意这条和用例 1 的区别：用例 1 数的是「首次查询**之前**不许发全量请求」，这条数的是「首次查询**之后**要发一次」。两条合起来才把语义钉死——只有前者的话，你现在这个版本也是绿的。

用例 1 的断言可能要跟着调整：现在空会话落地后会多出一次 `afterId=0` 的请求。把它改成「在首次查询落地**之前**，不带 afterId 的请求为 0 次」，或者按调用顺序断言，你自己选一个稳的写法。这条用例允许改。

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/22-events-double-load.json
```

输出原样贴进汇报第 4 节。汇报按六节格式写。
