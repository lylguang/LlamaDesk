import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import {
  HOOK_EVENTS,
  hooksFor,
  hooksStatus,
  normalizeHookEvent,
  parseHookConfigs,
  runHook,
  runHooks,
  type HookConfig,
} from "./agent-hooks";
import { updateSettings } from "./db/settings";

/**
 * 生命周期 hooks（对齐 Codex 的 SessionStart / UserPromptSubmit）。
 *
 * 三条必须钉住的语义：
 * 1. stdout 不是 JSON 就整段当上下文（`cat NOTES.md` 这种最朴素的写法要能用）；
 * 2. 只有明确的 `{"decision":"block"}` 才拦回合 —— 失败 / 超时都只是警告；
 * 3. 上下文有硬上限：hook 的输出会进上下文窗口，本地模型窗口不大。
 */
let dir: string;

const hook = (command: string, event: HookConfig["event"] = "user_prompt_submit"): HookConfig => ({
  event,
  command,
  timeoutMs: 5000,
});

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "omni-hooks-"));
  updateSettings({ AGENT_HOOKS: "[]" });
});

afterEach(() => {
  updateSettings({ AGENT_HOOKS: "[]" });
  rmSync(dir, { recursive: true, force: true });
});

describe("配置解析", () => {
  test("事件名两种写法都认（Codex 的 PascalCase 可以直接粘）", () => {
    expect(normalizeHookEvent("user_prompt_submit")).toBe("user_prompt_submit");
    expect(normalizeHookEvent("UserPromptSubmit")).toBe("user_prompt_submit");
    expect(normalizeHookEvent("SessionStart")).toBe("session_start");
    expect(normalizeHookEvent("session-start")).toBe("session_start");
    expect(normalizeHookEvent("PreToolUse")).toBeNull(); // 未支持的事件如实说不认识
    expect(HOOK_EVENTS).toEqual(["session_start", "user_prompt_submit"]);
  });

  test("坏条目被丢弃并说明原因，其余 hook 照常生效", () => {
    const { hooks, errors } = parseHookConfigs(
      JSON.stringify([
        { event: "user_prompt_submit", command: "echo a" },
        { event: "PreToolUse", command: "echo b" },
        { event: "session_start" },
        "not-an-object",
      ]),
    );
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.command).toBe("echo a");
    expect(hooks[0]!.timeoutMs).toBe(5000);
    expect(errors).toHaveLength(3);
  });

  test("非 JSON / 非数组直接报错（设置页要能告诉用户哪里写错了）", () => {
    expect(parseHookConfigs("{").errors[0]).toContain("不是合法 JSON");
    expect(parseHookConfigs('{"event":"x"}').errors[0]).toContain("必须是数组");
    expect(parseHookConfigs("").hooks).toHaveLength(0);
  });

  test("按事件过滤；未配置时一次都不跑", async () => {
    updateSettings({
      AGENT_HOOKS: JSON.stringify([
        { event: "SessionStart", command: "echo startup" },
        { event: "user_prompt_submit", command: "echo prompt" },
      ]),
    });
    expect(hooksFor("session_start")).toHaveLength(1);
    expect(hooksFor("user_prompt_submit")).toHaveLength(1);
    expect(hooksStatus().hooks).toHaveLength(2);

    updateSettings({ AGENT_HOOKS: "[]" });
    const outcome = await runHooks("user_prompt_submit", {
      conversationId: 1,
      workspace: dir,
      mode: "agent",
    });
    expect(outcome.runs).toBe(0);
    expect(outcome.context).toEqual([]);
  });
});

describe("单条 hook 的契约", () => {
  test("事件 JSON 从 stdin 交给脚本；事件名在环境变量里", async () => {
    // 用脚本读 stdin（真实场景里就是 jq / python 解析），输出**纯文本**。
    // 注意：hook 的 stdout 只要长得像 JSON 就会被当成"响应"，所以脚本别把输入原样打回来。
    const reader =
      "python3 -c 'import json,sys; d=json.load(sys.stdin); " +
      "print(d[\"conversationId\"], d[\"prompt\"], d[\"event\"], d[\"workspace\"], sep=\"|\")'";
    const fromStdin = await runHook(hook(reader), {
      event: "user_prompt_submit",
      conversationId: 42,
      workspace: dir,
      mode: "agent",
      prompt: "帮我改代码",
    });
    expect(fromStdin.context).toBe(`42|帮我改代码|user_prompt_submit|${dir}`);

    // 把输入原样打回去 → 看起来像"没有 decision / context 的 JSON 响应"，
    // 报错要说清楚怎么改（这条曾经让测试自己踩坑）。
    const echoed = await runHook(hook("cat"), {
      event: "user_prompt_submit",
      conversationId: 1,
      workspace: dir,
      mode: "agent",
    });
    expect(echoed.context).toBeUndefined();
    expect(echoed.error).toContain("decision");

    const fromEnv = await runHook(hook(`printf '%s' "$OMNI_HOOK_EVENT"`), {
      event: "user_prompt_submit",
      conversationId: 7,
      workspace: dir,
      mode: "agent",
    });
    expect(fromEnv.context).toBe("user_prompt_submit");
  });

  test("echo 出来的就是纯文本（不追加参数，JSON 不会混进上下文）", async () => {
    const result = await runHook(hook("echo 干净的一段上下文"), {
      event: "user_prompt_submit",
      conversationId: 1,
      workspace: dir,
      mode: "agent",
    });
    expect(result.context).toBe("干净的一段上下文");
  });

  test("stdout 不是 JSON → 整段当上下文；是 JSON → 认 context / decision", async () => {
    const plain = await runHook(hook("echo '来自文件的上下文'"), {
      event: "user_prompt_submit",
      conversationId: 1,
      workspace: dir,
      mode: "agent",
    });
    expect(plain.context).toBe("来自文件的上下文");

    const json = await runHook(hook(`echo '{"context":"结构化上下文"}'`), {
      event: "user_prompt_submit",
      conversationId: 1,
      workspace: dir,
      mode: "agent",
    });
    expect(json.context).toBe("结构化上下文");

    const allow = await runHook(hook(`echo '{"decision":"allow"}'`), {
      event: "user_prompt_submit",
      conversationId: 1,
      workspace: dir,
      mode: "agent",
    });
    expect(allow.blocked).toBe(false);
    expect(allow.context).toBeUndefined();
  });

  test("只有明确的 block 才拦回合；失败与超时都只是警告", async () => {
    const blocked = await runHook(hook(`echo '{"decision":"block","reason":"提示词里有密钥"}'`), {
      event: "user_prompt_submit",
      conversationId: 1,
      workspace: dir,
      mode: "agent",
    });
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toBe("提示词里有密钥");

    const failed = await runHook(hook("exit 3"), {
      event: "user_prompt_submit",
      conversationId: 1,
      workspace: dir,
      mode: "agent",
    });
    expect(failed.blocked).toBe(false);
    expect(failed.error).toContain("退出码 3");

    const slow = await runHook({ event: "user_prompt_submit", command: "sleep 5", timeoutMs: 200 }, {
      event: "user_prompt_submit",
      conversationId: 1,
      workspace: dir,
      mode: "agent",
    });
    expect(slow.blocked).toBe(false);
    expect(slow.error).toContain("超时");
  });

  test("忽略 SIGTERM 的 hook 也一定会结束（升级 SIGKILL，不卡死回合）", async () => {
    // trap 掉 TERM 再 sleep：只发一次 SIGTERM 的话这个进程不会退出，
    // 而 `runHook` 在等 `proc.exited` —— 整个 Agent 回合就停在这里不动了
    // （界面上是"一直在处理中"，且没有任何报错）。宽限期后补 SIGKILL 才收得掉。
    const started = Date.now();
    const stubborn = await runHook(
      {
        event: "user_prompt_submit",
        command: "trap '' TERM; sleep 30",
        timeoutMs: 200,
      },
      { event: "user_prompt_submit", conversationId: 1, workspace: dir, mode: "agent" },
    );
    const elapsed = Date.now() - started;

    expect(stubborn.blocked).toBe(false);
    expect(stubborn.error).toContain("超时");
    // 200ms 超时 + 2s 宽限 + 余量：关键是**远小于**脚本自己要睡的 30s。
    expect(elapsed).toBeLessThan(10_000);
  }, 15_000);

  test("负载超过 64KB 时钩子仍然跑得起来，stdin 拿到的是完整负载", async () => {
    // Linux 单个环境变量串在 128KB 处抛 E2BIG；负载里含用户提问正文，
    // 粘一大段日志就能超线。之前超线 = spawn 抛错 = 所有钩子变成“没拦”，
    // 拦截型钩子被静默绕过。现在 env 这一路超限就不设，stdin 照传完整内容。
    const bigPrompt = "x".repeat(200 * 1024);
    const payload = {
      event: "user_prompt_submit",
      conversationId: 9,
      workspace: dir,
      mode: "agent",
      prompt: bigPrompt,
    };
    const expectedBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    // wc -c 数的是字节（不是字符）：`printf 'hello世界' | wc -c` = 11。
    const result = await runHook(hook(`wc -c | tr -d ' '`), payload);
    expect(result.error).toBeUndefined();
    // stdout 是纯数字文本 → 整段当上下文；长度必须和序列化后的字节数对上（完整负载）。
    expect(result.context).toBe(String(expectedBytes));
  });

  test("负载超过 64KB 时不设 OMNI_HOOK_PAYLOAD，但 OMNI_HOOK_PAYLOAD_BYTES 准确", async () => {
    const bigPrompt = "y".repeat(200 * 1024);
    const payload = {
      event: "user_prompt_submit",
      conversationId: 10,
      workspace: dir,
      mode: "agent",
      prompt: bigPrompt,
    };
    const expectedBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    // 脚本自己判：payload 变量是否存在（`${VAR+x}` 能分清「未设置」和「空串」）、
    // 字节数字符串对不对、事件名是否在。
    const script =
      "if [ -n \"${OMNI_HOOK_PAYLOAD+x}\" ]; then echo 0; else echo 1; fi; " +
      "printf '%s' \"$OMNI_HOOK_PAYLOAD_BYTES\"; echo; " +
      "printf '%s' \"$OMNI_HOOK_EVENT\"";
    const result = await runHook(hook(script), payload);
    expect(result.error).toBeUndefined();
    expect(result.context).toBe(`1\n${expectedBytes}\nuser_prompt_submit`);
  });

  test("负载很小时 OMNI_HOOK_PAYLOAD 照旧存在且与 stdin 一致", async () => {
    const payload = {
      event: "user_prompt_submit",
      conversationId: 11,
      workspace: dir,
      mode: "agent",
      prompt: "小负载",
    };
    const serialized = JSON.stringify(payload);
    const expectedBytes = Buffer.byteLength(serialized, "utf8");
    // 先把 stdin 落到工作区里的文件再比，避免命令替换里塞大 JSON。
    const inPath = path.join(dir, "in.json");
    const script =
      `cat > "${inPath}"; if [ "$OMNI_HOOK_PAYLOAD" = "$(cat "${inPath}")" ]; then echo True; else echo False; fi; ` +
      "printf '%s' \"$OMNI_HOOK_PAYLOAD_BYTES\"";
    const result = await runHook(hook(script), payload);
    expect(result.error).toBeUndefined();
    expect(result.context).toBe(`True\n${expectedBytes}`);
  });

  test("字节数不是字符数：多字节（中文）负载在字节上限之上时同样不设 OMNI_HOOK_PAYLOAD", async () => {
    // 80KB 的中文 = 240KB 字节，字符数与字节数同时超线，分不出两种判断法。
    // 所以取 50KB 字符 / 150KB 字节：字符数没超 64K，字节数超了。
    // 按字符数判断的写法会漏判，把 150KB 的串塞进 env，spawn 直接 E2BIG。
    const payload = {
      event: "user_prompt_submit",
      conversationId: 12,
      workspace: dir,
      mode: "agent",
      prompt: "中".repeat(50 * 1024),
    };
    const expectedBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    expect(expectedBytes).toBeGreaterThan(64 * 1024); // 字节确实超限
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(64 * 1024); // 但字符数没超（正是变异点）
    const result = await runHook(
      hook("if [ -n \"${OMNI_HOOK_PAYLOAD+x}\" ]; then echo 0; else echo 1; fi; " + "printf '%s' \"$OMNI_HOOK_PAYLOAD_BYTES\""),
      payload,
    );
    expect(result.error).toBeUndefined();
    expect(result.context).toBe(`1\n${expectedBytes}`);
  });
});

describe("一次事件跑多条", () => {
  test("上下文按顺序拼接；遇到 block 立刻停（后面的不再跑）", async () => {
    updateSettings({
      AGENT_HOOKS: JSON.stringify([
        { event: "user_prompt_submit", command: "echo 第一条" },
        { event: "user_prompt_submit", command: "echo 第二条" },
      ]),
    });
    const outcome = await runHooks("user_prompt_submit", {
      conversationId: 1,
      workspace: dir,
      mode: "agent",
    });
    expect(outcome.context).toEqual(["第一条", "第二条"]);
    expect(outcome.runs).toBe(2);

    const marker = path.join(dir, "third-ran");
    updateSettings({
      AGENT_HOOKS: JSON.stringify([
        { event: "user_prompt_submit", command: `echo '{"decision":"block","reason":"停下"}'` },
        { event: "user_prompt_submit", command: `touch ${marker}` },
      ]),
    });
    const stopped = await runHooks("user_prompt_submit", {
      conversationId: 1,
      workspace: dir,
      mode: "agent",
    });
    expect(stopped.blocked).toBe(true);
    expect(stopped.runs).toBe(1);
    expect(Bun.file(marker).size).toBe(0);
  });

  test("有一条失败时其余照跑，失败原因如实带出来", async () => {
    updateSettings({
      AGENT_HOOKS: JSON.stringify([
        { event: "session_start", command: "exit 1" },
        { event: "session_start", command: "echo 还是跑到了" },
      ]),
    });
    const outcome = await runHooks("session_start", {
      conversationId: 1,
      workspace: dir,
      mode: "agent",
    });
    expect(outcome.context).toEqual(["还是跑到了"]);
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0]).toContain("退出码 1");
  });

  test("上下文有硬上限（单条 8KB，合计 16KB）", async () => {
    // 3 条各 8KB：第 3 条应该被总量上限截掉。
    const big = (mark: string) => `printf '%s' "$(python3 -c "print('${mark}'*8192)")"`;
    updateSettings({
      AGENT_HOOKS: JSON.stringify([
        { event: "user_prompt_submit", command: big("a") },
        { event: "user_prompt_submit", command: big("b") },
        { event: "user_prompt_submit", command: big("c") },
      ]),
    });
    const outcome = await runHooks("user_prompt_submit", {
      conversationId: 1,
      workspace: dir,
      mode: "agent",
    });
    const total = outcome.context.join("").length;
    expect(total).toBeLessThanOrEqual(16 * 1024);
    expect(outcome.context[0]!.length).toBeLessThanOrEqual(8 * 1024);
  });
});
