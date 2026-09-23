import { beforeAll, describe, expect, test } from "bun:test";

// 与 app-log.test.ts 同一套约定：用 bunfig 预加载的数据目录，不自己改 OMNI_DATA_DIR。
const { clearAppLog, logEvent, readAppLogs, redactSecrets, sanitizeValue } = await import("./app-log");

/**
 * 日志脱敏的**内容**一层（FUT-03）。
 *
 * 老实现只按字段名替换：`{ apiKey: "sk-…" }` 会变成 `{ apiKey: "***" }`，但真正
 * 泄漏密钥的那些路径根本不吃这一套 —— 命令行（`command`）、URL（`url`）、
 * 环境变量转储（`args`）都是「字段名无害、值里带密钥」。这里把那些形状钉住。
 */

beforeAll(() => {
  clearAppLog();
});

describe("redactSecrets：认得出的密钥形状", () => {
  test("命令行里的 Authorization 头", () => {
    const line = `curl -s -H "Authorization: Bearer sk-proj-abcdefghijklmnop" https://api.example.com/v1`;
    const out = redactSecrets(line);
    expect(out).not.toContain("sk-proj-abcdefghijklmnop");
    // 头名留着（知道是哪种认证），值整段换成 ***
    expect(out).toContain("Authorization: ***");
    // 结构要留住，否则这条日志就没法排查了
    expect(out).toContain("https://api.example.com/v1");
    expect(out).toContain("curl -s");
  });

  test("裸的 Bearer（没有 Authorization 前缀）也要认", () => {
    expect(redactSecrets("token rejected: Bearer abcdef1234567890")).toContain("Bearer ***");
  });

  test("带固定前缀的密钥，出现在哪都脱", () => {
    for (const secret of [
      "sk-1234567890abcdefgh",
      "osk-live-abcdefghijklm",
      "hf_AbCdEfGhIjKlMnOp",
      "ghp_1234567890abcdef",
      "glpat-abcdefghijklmnop",
    ]) {
      expect(redactSecrets(`推送失败：${secret}`)).not.toContain(secret);
    }
  });

  test("赋值形态：query、env 转储、JSON 片段", () => {
    expect(redactSecrets("GET /v1/models?api_key=abcdef123456")).not.toContain("abcdef123456");
    expect(redactSecrets("IMG_API_KEY=abcdef123456 provider=x")).not.toContain("abcdef123456");
    expect(redactSecrets(`{"token": "abcdef123456"}`)).not.toContain("abcdef123456");
    expect(redactSecrets("--password hunter2hunter2 end")).not.toContain("hunter2hunter2");
  });

  test("URL 里的 userinfo（备份远端 / 代理）", () => {
    const out = redactSecrets("remote: https://backup:s3cret-pass@nas.local/omni");
    expect(out).not.toContain("s3cret-pass");
    expect(out).toContain("https://backup:***@nas.local/omni");
  });

  test("X-Api-Key 这类头", () => {
    const out = redactSecrets('headers: {"x-api-key": "abcdef123456"}');
    expect(out).not.toContain("abcdef123456");
  });
});

describe("redactSecrets：不误伤正常内容", () => {
  test("token 计数不是密钥", () => {
    const line = "usage: prompt_tokens=1024 completion_tokens=512 tokens=1536";
    expect(redactSecrets(line)).toBe(line);
  });

  test("路径、模型名、命令原样保留", () => {
    const line = "/Users/x/models/qwen3-8b-instruct-Q4_K_M.gguf --ctx-size 8192";
    expect(redactSecrets(line)).toBe(line);
  });

  test("短值不动（`token=1` 这种是参数不是密钥）", () => {
    expect(redactSecrets("token=abc")).toBe("token=abc");
  });

  test("空串与无密钥文本原样返回", () => {
    expect(redactSecrets("")).toBe("");
    expect(redactSecrets("一次普通的启动失败")).toBe("一次普通的启动失败");
  });
});

describe("脱敏接在写日志的路径上", () => {
  test("message 里的密钥会脱掉", () => {
    const entry = logEvent({
      level: "error",
      source: "server",
      event: "hook.failed",
      message: `hook 失败：curl -H "Authorization: Bearer sk-live-abcdefghijklmnop" http://x`,
    });
    expect(entry.message).not.toContain("sk-live-abcdefghijklmnop");
  });

  test("detail 里字符串值里的密钥会脱掉（字段名无害也一样）", () => {
    const clean = sanitizeValue({
      command: "curl --data 'api_key=abcdef123456' http://x",
      url: "https://u:p4ssw0rdlong@example.com/hook",
      args: ["Bearer abcdef1234567890"],
    }) as Record<string, unknown>;
    expect(JSON.stringify(clean)).not.toContain("abcdef123456");
    expect(JSON.stringify(clean)).not.toContain("p4ssw0rdlong");
  });

  test("以前漏掉的字段名（access_key / credential）现在也整体替换", () => {
    const clean = sanitizeValue({
      access_key: "abcdef123456",
      credential: "abcdef123456",
      nested: { secret_key: "abcdef123456" },
    }) as Record<string, unknown>;
    expect(clean.access_key).toBe("***");
    expect(clean.credential).toBe("***");
    expect((clean.nested as Record<string, unknown>).secret_key).toBe("***");
  });

  test("落盘文件里搜不到那条密钥", () => {
    clearAppLog();
    logEvent({
      level: "error",
      source: "gateway",
      event: "gateway.request.failed",
      message: "上游拒绝",
      detail: { command: "curl -H 'Authorization: Bearer sk-leak-abcdefghijkl' http://x" },
    });
    const entries = readAppLogs({ limit: 20 });
    const text = JSON.stringify(entries);
    expect(text).toContain("gateway.request.failed");
    expect(text).not.toContain("sk-leak-abcdefghijkl");
  });
});
