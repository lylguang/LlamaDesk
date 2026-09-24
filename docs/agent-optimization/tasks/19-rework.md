# 任务 19 返工：第二条用例会让测试套件多跑 10 分钟

源码改得对，第一条用例也对。问题出在第二条。

允许改动的文件同上一轮。

## 问题

`apps/studio/src/bun/agent-tools.bash.test.ts` 第 86 到 109 行那条用例，为了验证「超上限时夹到 600000」，**真的跑了一条 `sleep 2000` 并等它在 600 秒时被杀**，用例自己的超时还开到了 650 秒。

这条用例一进主干，**每次跑测试都要多等 10 分钟**。整个套件现在跑完只要 11 秒，这一条就把它变成 10 分多钟。上一轮你自己超时被杀（退出码 124），多半也是卡在等它。

验证一个夹取逻辑，不应该靠真的等那么久。

## 怎么改

**把夹取逻辑抽成一个小的纯函数并导出，直接对它做单元测试。**

（上一轮任务说明里写的「不要为此去导出内部变量」，指的是不要把模块私有的可变状态挖出来。抽一个无副作用的纯函数出来做测试入口是另一回事，这次明确允许。）

在 `apps/studio/src/bun/agent-tools.ts` 里，把第 802 行附近那段三元表达式抽出来：

```
/** bash 超时的取值链：模型参数 > ToolContext 覆盖 > 默认 120 秒；参数夹在 [1000, 600000]。 */
export function resolveCommandTimeout(requested: unknown, ctxTimeout?: number): number {
  ...
}
```

`createBash` 里改成调用它，行为跟现在完全一致，不要顺手改语义。

然后把第 86 行那条用例**整条换掉**，改成对 `resolveCommandTimeout` 的直接断言，至少覆盖：

- `resolveCommandTimeout(999_999_999, undefined)` → `600_000`（上限夹取）
- `resolveCommandTimeout(300, undefined)` → `1_000`（下限夹取）
- `resolveCommandTimeout(0, 4_000)` → `4_000`（0 是非法值，退回 ctx，**不能**当成 0 毫秒）
- `resolveCommandTimeout(-5, undefined)` → `120_000`
- `resolveCommandTimeout(Number.NaN, undefined)` → `120_000`
- `resolveCommandTimeout(Number.POSITIVE_INFINITY, undefined)` → `120_000`
- `resolveCommandTimeout(undefined, undefined)` → `120_000`
- `resolveCommandTimeout(undefined, 4_000)` → `4_000`
- `resolveCommandTimeout(30_000, 4_000)` → `30_000`（参数优先于 ctx）

这条用例必须是**毫秒级**跑完的，不许有任何 sleep，也不许设 `timeout` 选项。

## 保留

第 71 行那条「传了 timeout_ms 就按它来」保留不动——它是真的把参数跑通了一遍（端到端证明参数确实接到了 spawn 的定时器上），而且只花 300 毫秒。纯函数测试证明不了「接线对不对」，这条证明得了，两条都要。

## 自检

改完跑一次 `bun test --parallel apps/studio/src/bun/agent-tools.bash.test.ts`，**整个文件应当在几秒内跑完**。把耗时那一行贴进汇报。

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/19-bash-timeout-param.json
```

输出原样贴进汇报第 4 节。汇报按六节格式写。
