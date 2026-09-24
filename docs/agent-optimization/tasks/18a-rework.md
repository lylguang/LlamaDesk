# 任务 18a 返工：`maxChars` 为 0 时会把**整段原文**原样吐回来

主体改得对，头尾两段、中间说明、末尾提示都没问题。只有一个边界要补。

只改这两个文件（同上一轮白名单）。

## Bug

你写的是：

```
  const tail = text.slice(-1 * (max - headLen));
```

`max` 为 0 时，`headLen = 0`，于是 `max - headLen = 0`，`text.slice(-0)`。

JavaScript 里 `-0 === 0`，所以 `text.slice(-0)` 等价于 `text.slice(0)` —— **返回整个字符串**。

结果就是：`truncateForModel(text, { maxChars: 0 })` 报告 `truncated: true`，却把 5100 字符的原文一字不少地塞了回去。

## 实测证据

同一段 5100 字符的文本，按不同 `maxChars` 量「实际保留的原文长度」：

```
max=0    实际保留 5100 字符（应为 0）   ← 就是这个
max=1    正确
max=2    正确
max=3    正确
max=5    正确
max=10   正确
max=99   正确
max=100  正确
max=101  正确
max=1000 正确
max=5099 正确
```

只有 0 这一个点出问题，别的都对。

## 为什么现在就要修

现在没有调用方传 0，所以线上碰不到。但紧接着的 18b 要让上限**按上下文窗口算出来**再传进来——窗口配小了、或者算式里某一项为 0，就会正好踩中这个点。到那时的表现是「本该截断的超大输出被整段塞进上下文」，比不截断还糟，而且极难定位。现在一行就能堵上。

## 怎么改

1. 把尾部长度先算出来，只有大于 0 才取尾部：

   ```
   const tailLen = max - headLen;
   const tail = tailLen > 0 ? text.slice(-tailLen) : "";
   ```

2. 顺手把 `max` 夹到非负：`const max = Math.max(0, opts.maxChars ?? MAX_TOOL_OUTPUT_CHARS);`
   负数会让 `text.slice(0, 负数)` 从末尾往回切，同样是错的。

3. 中间那行省略说明、末尾那几句提示都不要动。

## 补两条用例

1. **`maxChars: 0` 时不返回任何原文内容**：断言结果里既不含开头标记也不含结尾标记，且 `truncated` 为 `true`。
2. **`maxChars` 为负数时同样不返回原文内容**。

顺带把「头尾合计正好等于 max」那条用例的 `maxChars` 多取几个值跑一遍（比如 1、2、10、100、1000），别只测一个。

## 自检

改完自己按上面那张表的取值跑一遍，确认每个点保留的原文长度都等于 `max`（`max` 为 0 时是 0）。把这组输出贴进汇报第 2 节。

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/18a-truncate-head-tail.json
```

输出原样贴进汇报第 4 节。汇报按六节格式写。
