# 任务 15：摘要失败没有熔断，每一步都可能再等 90 秒

工作树根目录：`/home/xixi/Git/OmniStudio/.claude/worktrees/agent-optimize`

## 允许改动的文件（只有这两个）

1. `apps/studio/src/bun/agent.ts` —— 只许改下面点明的地方
2. `apps/studio/src/bun/agent-summary-breaker.test.ts` —— 你要新建的测试文件

别的文件一个都不许碰。`agent.ts` 有 3300 多行，**不要通读它**，按行号定位。

## 现状

自动压缩走摘要时，`makeContextTransform` 里会调模型写摘要（第 2033 行附近）：

```
2033          const outcome = await summarizeHistory({
...
2044          if (outcome.ok) {
2045            host.summary = { ... };
...
2052            // 摘要是"锦上添花"：失败就退回确定性裁剪，这一轮必须照常发出去。
```

摘要调用的超时是 90 秒（`apps/studio/src/bun/agent-summary.ts` 第 137 行 `SUMMARY_TIMEOUT_MS = 90_000`）。

另外第 1129 行 `Session` 类型上有个字段：

```
1129    summarizing: Promise<void> | null;
```

第 2201 行初始化成 `null`，**全文再无任何读写**——死字段。

## 缺陷

`makeContextTransform` 在**每次模型调用之前**都会跑（同文件第 1144 行注释）。一个回合里模型要调很多次（每步一次、重试也各一次）。

摘要要是一直失败（模型不支持、返回格式不对、每次都超时），**每一步都会重新试一次，每次最多再等 90 秒**。一个十几步的回合可能凭空多花十几分钟，而用户看到的只是「处理中」的秒数在涨，没有任何提示。

代码注释说「摘要是锦上添花：失败就退回确定性裁剪」——这个设计是对的，问题是**它没记住自己失败过**，所以每一步都要重新付一次代价。

## 期望语义

**一、加一个按会话的摘要熔断。**

在 `Session` 类型（第 1129 行那个字段旁边）把死字段 `summarizing` 换掉——直接删掉它，新增：

```
  /**
   * 摘要熔断：上次摘要失败的时刻。
   *
   * `transformContext` 每次模型调用前都会跑，而摘要超时是 90 秒；一直失败的话
   * 一个十几步的回合会凭空多花十几分钟，用户只看到「处理中」在涨。失败后冷却
   * 一段时间，期间直接走确定性裁剪（那本来就是失败时的退路）。
   */
  summaryFailedAt: number | null;
```

第 2201 行的初始化跟着改成 `summaryFailedAt: null,`。

**二、用起来。**

- 在第 2028 行那个 `if (cut !== null && cut > covered)` 的条件里再加一项：距上次失败不足冷却时间就跳过摘要（直接走后面的确定性裁剪）。
- 摘要失败那一支（第 2052 行附近的注释所在处）记下 `host.summaryFailedAt = Date.now();`。
- 摘要**成功**时把它清回 `null`（否则一次偶发失败会在整个冷却期内拖累后续）。
- 冷却时长加一个模块级常量，取 **5 分钟**，写清为什么：

  ```
  /** 摘要失败后的冷却：期间只走确定性裁剪。90 秒超时 × 十几步足够把一个回合拖垮。 */
  const SUMMARY_COOLDOWN_MS = 5 * 60_000;
  ```

**注意** `host` 的类型是 `CompactionHost`（`makeContextTransform` 的第一个参数），字段要加在它上面才拿得到；子智能体那处（第 1596 行附近）传的是个字面量对象，**也要补上这个字段**，否则类型不过。

## 不要做的事

- 不要改 `summarizeHistory` 本身，也不要改 `SUMMARY_TIMEOUT_MS`
- 不要改确定性裁剪（`compactMessages`）
- 不要改 `findSummaryCut`
- 不要给用户加提示或设置项（「不加开关」）

## 测试要求

新建 `apps/studio/src/bun/agent-summary-breaker.test.ts`。

`makeContextTransform` 是**导出**的（第 1958 行附近），可以直接构造 `host` 调它，不必起完整回合——这样测得又快又准。看一眼它的签名和 `CompactionHost` 的字段，自己构造入参。

摘要失败怎么造：摘要是通过模型调的，用 `test-stub-llm` 起一个**总是返回 500** 的桩并把设置指向它，摘要就会失败。

至少覆盖这 3 条：

1. **摘要失败后会记下失败时刻**：构造一个足够大的历史（顶穿预算才会触发摘要），跑一次 transform，断言 `host.summaryFailedAt` 不为 null。
2. **冷却期内不再尝试摘要**（**这条就是本次要修的缺陷**）：紧接着再跑一次 transform，断言桩服务**没有收到新的摘要请求**（数请求次数）。改之前它会再试一次。
3. **摘要成功会把熔断清掉**：把 `host.summaryFailedAt` 手动设成一个很久以前的时刻（超出冷却），换成正常应答的桩，跑一次 transform，断言摘要成功且 `summaryFailedAt` 回到 null。

如果构造 `host` 或触发摘要比预想的复杂，**不要硬凑、不要改源码绕过**，在汇报第 6 节写清卡在哪。

## 验收标准（汇报第 5 节逐条填）

- [ ] 死字段 `summarizing` 已删
- [ ] 新字段加在 `CompactionHost` 上，两个构造点都补了
- [ ] 冷却常量 5 分钟，带注释说明理由
- [ ] 失败记时刻、成功清 null、冷却期内跳过摘要，三条都落实
- [ ] 没有动 `summarizeHistory` / `SUMMARY_TIMEOUT_MS` / `compactMessages` / `findSummaryCut`
- [ ] 没有加设置项或用户提示
- [ ] 把 `agent.ts` 的改动还原后，第 2 条用例会变红（你自己先试一遍）
- [ ] 源码改动不超过 30 行

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/15-summary-circuit-breaker.json
```

输出原样贴进汇报第 4 节。
