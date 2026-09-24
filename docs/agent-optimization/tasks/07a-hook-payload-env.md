# 任务 07a：钩子的完整负载塞进环境变量，负载一大就整条钩子起不来

工作树根目录：`/home/xixi/Git/OmniStudio/.claude/worktrees/agent-optimize`

## 允许改动的文件（只有这两个）

1. `apps/studio/src/bun/agent-hooks.ts` —— 源码，只许改 `runHook` 里 `Bun.spawn` 的 `env` 那几行，外加在常量区加一个常量
2. `apps/studio/src/bun/agent-hooks.test.ts` —— 既有测试文件，**只许加用例，现有 14 条一条都不许删、不许改**

别的文件一个都不许碰。

## 现状

`apps/studio/src/bun/agent-hooks.ts` 第 140 到 162 行，`runHook` 的开头：

```
140    const shell = resolveCommandShell();
141    const serialized = JSON.stringify(payload);
142    let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
143    try {
144      proc = Bun.spawn({
145        cmd: shell.commandArgs(hook.command),
146        env: {
147          ...process.env,
148          OMNI_HOOK_EVENT: hook.event,
149          OMNI_HOOK_PAYLOAD: serialized,
150        },
151        cwd: typeof payload.workspace === "string" && payload.workspace ? payload.workspace : process.cwd(),
152        stdout: "pipe",
153        stderr: "pipe",
154        stdin: "pipe",
155        detached: true,
156      });
157      // 事件 JSON 从 stdin 交给脚本（Codex 的 hook 也是这个契约）。
158      proc.stdin.write(serialized);
159      await proc.stdin.end();
160    } catch (error) {
161      return { blocked: false, error: `启动失败：${error instanceof Error ? error.message : String(error)}` };
162    }
```

## 缺陷

第 149 行把**完整的事件 JSON** 塞进环境变量 `OMNI_HOOK_PAYLOAD`。Linux 对单个环境变量字符串有长度上限，超了 `Bun.spawn` 直接抛 `E2BIG`。

本机实测（bun 1.4.2）：

```
127KB 的环境变量 → 起得来
128KB 的环境变量 → E2BIG: argument list too long, posix_spawn '/bin/true'
```

而 `payload` 里含用户这一轮的提问正文。用户粘一大段日志或者一整个文件进去，就能轻松超过这个线。

超了会怎样：第 144 行抛错 → 第 160 行接住 → 返回 `{ blocked: false }`。于是**所有钩子都变成「没拦」**。对拦截型钩子来说，这等于安全措施被静默绕过——用户以为配了拦截，实际上负载一大就自动放行。

关键是：**同一份内容第 158 行已经从 stdin 完整传了一遍**。环境变量这一路是多余的，却是唯一会炸的那一路。

## 期望语义

- stdin 仍然传完整负载，**这一路不许动**（第 157 到 159 行保持原样）。
- `OMNI_HOOK_EVENT` 照旧，永远设置。
- `OMNI_HOOK_PAYLOAD` 改成**只在负载不太大时才设置**：在常量区加

  ```
  /** 单个环境变量有长度上限（Linux 实测 128KB 处抛 E2BIG）。留一半余量。 */
  const MAX_PAYLOAD_ENV_BYTES = 64 * 1024;
  ```

  用 `Buffer.byteLength(serialized, "utf8")` 判断（**不要用 `.length`**，中文一个字符占 3 字节，按字符数判断会漏）。不超过就照旧设置；超过就**不设这个变量**。
- 不管设不设，都再加一个 `OMNI_HOOK_PAYLOAD_BYTES`，值是负载的字节数（转成字符串）。脚本据此就能知道「负载有多大」以及「要不要去读 stdin」。

这样负载再大也能把钩子起起来，拦截型钩子不会被绕过。

## 不要做的事

- 不要动 stdin 那一路
- 不要动超时、SIGTERM/SIGKILL、stdout/stderr 解析那些段落
- 不要改「启动失败时返回 `blocked: false`」这个行为——那是另一条任务（07b）
- 不要动 `parseHookConfigs`、`hookConfigs`、`hooksFor`

## 测试要求

往 `apps/studio/src/bun/agent-hooks.test.ts` 加用例。照现有第 98 行那条「事件 JSON 从 stdin 交给脚本；事件名在环境变量里」的写法搭场景——它已经示范了怎么写一个把 stdin 和环境变量落盘的钩子脚本。

至少覆盖这 3 条：

1. **负载超过 64KB 时钩子仍然跑得起来**，并且脚本从 stdin 收到的是**完整**负载（长度对得上）。
   （**这条就是本次要修的缺陷，改之前必须是红的**——现在会因为 E2BIG 起不来。）
   造大负载的办法：给 payload 里某个字段塞一段很长的字符串，比如 100KB。
2. 负载超限时 `OMNI_HOOK_PAYLOAD` 这个环境变量**不存在**，而 `OMNI_HOOK_PAYLOAD_BYTES` 存在且数值正确。
3. 负载很小时 `OMNI_HOOK_PAYLOAD` **照旧存在**且内容与 stdin 一致（防止把小负载那条老路也改坏）。

## 注意：这个测试文件里有一条会抖

`agent-hooks.test.ts` 里「stdout 不是 JSON → 整段当上下文」那条用例是计时敏感的，机器负载高时偶尔会红。**那不是你改坏的**，单独重跑一次一般就绿。如果你看到它红了，在汇报第 6 节说一句就行，不要为了让它变绿去改它。

## 验收标准（汇报第 5 节逐条填）

- [ ] 大负载下钩子能正常启动
- [ ] stdin 仍然拿到完整负载
- [ ] 超限时不设 `OMNI_HOOK_PAYLOAD`，不超限时照设
- [ ] `OMNI_HOOK_PAYLOAD_BYTES` 总是存在且数值正确
- [ ] 用 `Buffer.byteLength` 判断，不是 `.length`
- [ ] 上面列的「不要做的事」一条都没做
- [ ] 既有 14 条用例一条没删没改
- [ ] 把 `agent-hooks.ts` 的改动还原后，第 1 条用例会变红（你自己先试一遍）
- [ ] 源码改动不超过 25 行

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/07a-hook-payload-env.json
```

输出原样贴进汇报第 4 节。
