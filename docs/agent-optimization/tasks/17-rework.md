# 任务 17 返工：放行你问的那条断言

你在第 6 节提的两点都对。逐条回复：

## 1. 那条断言，放行——而且本来就该改

任务说明里「现有用例一条都不许改」这句在这条任务上写错了，是我的疏漏。第 105、106 行那两句断言**钉的正是这次要修的旧行为**（谁先吃预算），新语义下它必然失败。你选择不改、照实报 `RESULT FAIL` 并把冲突说清楚，这个处理是对的。

现在明确放行：**只许改 `apps/studio/src/bun/agent-instructions.test.ts` 里第 94 行那一条用例**（「超限时截断并标记；上限为 0 表示不限」），别的用例仍然一个字都不许动。

改成这样：

- 第 105 行：`expect(capped.files[0]!.contents).toBe("x".repeat(5));`
- 第 106 行：`expect(capped.files[1]!.contents).toBe("y".repeat(10));`

理由写进注释：两个文件各 10 字节、预算 15，最具体的 `/b` 先吃满 10 字节，剩 5 字节给 `/a`，输出仍按原顺序 `/a` 在前。

顺带把第 108 行那个变量名 `onlyFirst` 改掉——现在活下来的是**最后**那个文件，叫 `onlyFirst` 会误导。改成 `onlyLast`，并**补一句断言**说明活下来的是哪个：

```
expect(onlyLast.files[0]!.path).toBe("/b");
```

（这条补充断言很重要：原来那条只断言了「长度为 1」，不看是哪一个，正好漏掉了本次修复的关键语义。）

用例数量不变，仍是 21（17 个 test + 4 个 describe）。

## 2. 「现有 20 条」是我写错了

基线文件记的 21 行 = 17 个 test + 4 个 describe，你数得对。门比对的是用例名单有没有丢，`cases-missing none` 说明没丢。这点不用管。

## 改完自检

- 那条用例转绿，其余 20 条仍绿
- 源码**不要再动**，这轮只改测试

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/17-instructions-budget.json
```

输出原样贴进汇报第 4 节。汇报按六节格式写。
