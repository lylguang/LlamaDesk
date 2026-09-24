# 任务 09a：运行中的「排队发送」按钮永远点不动

工作树根目录：`/home/xixi/Git/OmniStudio/.claude/worktrees/agent-optimize`

## 允许改动的文件（只有这两个）

1. `apps/studio/src/mainview/app/agent/composer.tsx` —— 源码，只许改第 322 到 324 行那几行
2. `apps/studio/src/mainview/app/agent/composer-queue.test.tsx` —— 你要新建的测试文件

别的文件一个都不许碰。

## 现状

`apps/studio/src/mainview/app/agent/composer.tsx`：

第 322 到 324 行：

```
322    const busy = running || streaming;
323    const canSend =
324      (input.trim().length > 0 || attachments.length > 0 || fileAttachments.length > 0) && !busy;
```

第 751 行，运行中且输入框为空时显示停止按钮，**否则显示发送按钮**：

```
751                {busy && !input.trim() ? (
```

第 763 到 771 行，那个发送按钮：

```
763                  <PiTip label={busy ? t("agent.queue.send") : t("agent.send")}>
764                    <button
765                      type="button"
766                      className="send-btn"
767                      disabled={!canSend || sendMutation.isPending || queueMutation.isPending}
768                      onClick={() => {
769                        if (!busy && runSlashIfExact(input)) return;
770                        handleSend(busy ? "queue" : "send");
771                      }}
```

## 缺陷

运行中、输入框里有字时：

- 第 751 行判定 → 渲染的是**发送按钮**（不是停止按钮）；
- 第 763 行给它挂上「排队发送」的提示文案；
- 第 776 行给它换成排队用的图标；
- 第 770 行的点击处理明明写了 `busy ? "queue" : "send"`；
- 但第 767 行 `disabled={!canSend ...}`，而 `canSend` 在第 324 行要求 `!busy` —— **运行中恒为 false，按钮永远是禁用的**。

也就是说：这个按钮长得像排队按钮、写着排队文案、挂着排队逻辑，**但一次都点不动**。

排队功能本身是好的，后端 `followUpAgentMessage` 正常，键盘那条路也通——第 578 到 587 行的回车处理里，运行中按回车会走 `handleSend("queue")`。所以**只有不知道「要按回车」的用户被卡住**：他看到一个亮着排队图标的按钮，点下去没有任何反应。

## 期望语义

发送按钮的可用条件改成「输入框里有内容」即可，不再要求「没在运行」。

理由：运行中点它是**排队**，不是打断当前回合。第 769 行已经把斜杠命令那条路挡在 `!busy` 后面，第 770 行也已经按 `busy` 分流，点击路径本来就是对的，缺的只是让按钮可点。

把第 323 到 324 行改成：

```
  /** 有内容就能发：运行中点它是「排队」（见 handleSend 的 busy 分支），不是打断。 */
  const canSend = input.trim().length > 0 || attachments.length > 0 || fileAttachments.length > 0;
```

`busy` 那一行不要动，别处也不要动。

自己确认一遍：`canSend` 在这个文件里**只有第 767 行一处**用到（改之前先 grep 一次）。如果发现还有别处在用，停下来在汇报第 6 节说明，不要自己决定怎么办。

## 不变的地方

- 运行中且输入框为空 → 仍然显示停止按钮（第 751 行的判定不动）。
- 不在运行、输入框为空 → 按钮仍然禁用。
- 回车那条路不动。
- `queueMutation` / `handleSend` / `runSlashIfExact` 都不动。

## 测试要求

新建 `apps/studio/src/mainview/app/agent/composer-queue.test.tsx`。

**脚手架照抄 `apps/studio/src/mainview/app/agent/composer-slash.test.tsx` 的第 1 到 101 行**（happy-dom 全局注入、`mock.module("@lib/rpc", ...)` 那个把调用记进 `calls` 的 Proxy、清理钩子），以及它的 `type` / `clickSend` 辅助函数。需要给 mock 补 `followUpAgentMessage` 的返回值（`{ ok: true, queued: true }` 即可）。

把运行态打开的写法：`useAgentStore.getState().setRunning(true)`。

至少覆盖这 4 条：

1. **运行中输入文字后，发送按钮不是 disabled**（**这条就是本次要修的缺陷，改之前必定是 disabled**）。
2. **点它会发出排队请求**：断言 `calls` 里有一次 `followUpAgentMessage`，且参数里 `mode` 为 `"queue"`、`content` 是输入的那段文字。
3. **运行中输入框为空时，显示的是停止按钮**（`button.stop-btn` 存在、`button.send-btn` 不存在）——防止改过头把停止按钮挤掉。
4. **不在运行且输入框为空时，发送按钮仍然 disabled**——防止把「空输入也能发」放进来。

## 验收标准（汇报第 5 节逐条填）

- [ ] `canSend` 不再要求 `!busy`
- [ ] `canSend` 确认只有一处使用（grep 结果写进汇报）
- [ ] 运行中有内容 → 按钮可点，点击发出 `mode: "queue"` 的请求
- [ ] 运行中无内容 → 仍是停止按钮
- [ ] 空输入 → 仍然禁用
- [ ] `busy` 的定义、回车路径、`handleSend`、`queueMutation` 都没动
- [ ] 把 `composer.tsx` 的改动还原后，第 1 条用例会变红（你自己先试一遍）
- [ ] 源码改动不超过 8 行

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/09a-queue-button.json
```

输出原样贴进汇报第 4 节。
