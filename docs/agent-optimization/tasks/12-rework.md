# 任务 12 返工：任务陈述会被保留**两次**

思路对，但有一个真 bug，验收时用探针跑出来了。只改这两个文件（同上一轮的白名单）。

## Bug

你在循环里对 `taskIndex` 那条走的是这个分支：

```
    if (index === taskIndex) {
      kept.unshift(message);
      continue;
    }
```

`continue` 之前**没有更新 `firstKept`**。于是循环走过 `taskIndex`、又在下一次迭代 `break` 时，`firstKept` 还停在 `taskIndex + 1`，最后那句

```
  if (taskIndex > 0 && firstKept > taskIndex) kept.unshift(messages[taskIndex]!);
```

判定成立，于是**又插了一遍**——同一条任务陈述在结果里出现两次。

顺带 `dropped` 也不准了（它按 `messages.length - kept.length - 1` 算，多出来的那条把数算小了）。

## 实测证据

场景：第 1 条是老问题，中间 12 条很大的 assistant 填充，然后一条 user「这一轮：把导出做完」，最后 4 条很短的 assistant。

```
taskIndex=13 total=18
budget=60   任务陈述出现 2 次
budget=80   任务陈述出现 2 次
budget=100  任务陈述出现 2 次
budget=120  任务陈述出现 2 次
budget=150  任务陈述出现 2 次
budget=200  任务陈述出现 1 次
budget=300  任务陈述出现 1 次
```

预算卡在中间那一档就会重复：循环刚好能放下任务陈述、下一条大填充放不下就 break。

## 怎么改

`taskIndex` 那个分支里，`continue` 之前也要更新 `firstKept`。最省事的写法是把更新那句挪到两个分支共用的位置——`kept.unshift(message)` 之后立刻更新，两条路径都覆盖到。

改完之后，`firstKept` 的含义要严格是「循环实际保留到的最小下标」，不管是哪个分支放进去的。

别的地方都不要动。

## 补一条用例

把上面那个场景写成用例，断言任务陈述在结果里**只出现一次**。

用 `filter` 数一遍出现次数，断言等于 1。预算取会触发重复的那一档（100 左右）。

同时断言 `result.dropped` 等于 `messages.length - result.messages.length + 1`（占位那条不算在原始消息里），确保计数也对得上。

## 自检

改完自己再跑一遍上面那组预算（60 到 300），每一档都应该只出现 1 次。把这组输出贴进汇报第 2 节。

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/12-pin-current-task.json
```

输出原样贴进汇报第 4 节。汇报按六节格式写。
