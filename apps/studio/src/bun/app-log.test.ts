import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "fs";
import { join } from "path";

// 用 bunfig 预加载的数据目录（test-preload.ts），不要自己再覆盖 OMNI_DATA_DIR ——
// 单进程跑全部测试文件时，改 env 会泄漏给同进程的其它文件（model-store、media-tools
// 等都在读它）。日志只落在这一个子目录里，不会干扰别人。
const dataDir = process.env.OMNI_DATA_DIR!;

const {
  appLogDir,
  appLogInfo,
  appLogPath,
  clearAppLog,
  logEvent,
  readAppLogFiles,
  readAppLogsInMemory,
  sanitizeValue,
} = await import("./app-log");

beforeAll(() => {
  clearAppLog();
});

afterAll(() => {
  clearAppLog();
});

describe("落盘与读取", () => {
  test("写一条就有一条，字段齐全", () => {
    const entry = logEvent({
      level: "error",
      source: "image",
      event: "image.generate.failed",
      message: "生图失败",
      detail: { backend: "api" },
    });
    expect(entry.level).toBe("error");
    expect(entry.source).toBe("image");
    expect(entry.pid).toBe(process.pid);

    // 内存与文件两条路径都要能看到。
    const inMemory = readAppLogsInMemory({ source: "image" });
    expect(inMemory.some((e) => e.event === "image.generate.failed")).toBe(true);

    const fromFile = readAppLogFiles({ source: "image" });
    expect(fromFile.some((e) => e.event === "image.generate.failed")).toBe(true);

    const raw = readFileSync(appLogPath(), "utf8");
    expect(raw).toContain("image.generate.failed");
    expect(raw.endsWith("\n")).toBe(true);
  });

  test("文件是逐行 JSONL，可逐行解析", () => {
    clearAppLog();
    logEvent({ source: "video", event: "a", message: "1" });
    logEvent({ source: "video", event: "b", message: "2" });
    const lines = readFileSync(appLogPath(), "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  test("日志落在 <数据目录>/logs/app.log", () => {
    expect(appLogDir()).toBe(join(dataDir, "logs"));
    expect(appLogPath()).toBe(join(dataDir, "logs", "app.log"));
    expect(appLogInfo().dir).toBe(appLogDir());
  });

  test("清空后文件消失、内存归零", () => {
    logEvent({ source: "app", event: "x", message: "x" });
    expect(readAppLogsInMemory({ limit: 10 }).length).toBeGreaterThan(0);
    clearAppLog();
    expect(readAppLogsInMemory({ limit: 10 })).toHaveLength(0);
    expect(() => statSync(appLogPath())).toThrow();
  });
});

describe("过滤", () => {
  test("level 按「该级别及以上」过滤", () => {
    clearAppLog();
    logEvent({ level: "debug", source: "app", event: "d", message: "d" });
    logEvent({ level: "info", source: "app", event: "i", message: "i" });
    logEvent({ level: "warn", source: "app", event: "w", message: "w" });
    logEvent({ level: "error", source: "app", event: "e", message: "e" });

    expect(readAppLogsInMemory({ level: "warn" }).map((e) => e.event).sort()).toEqual(["e", "w"]);
    expect(readAppLogsInMemory({ level: "error" }).map((e) => e.event)).toEqual(["e"]);
    expect(readAppLogsInMemory({ level: "debug" })).toHaveLength(4);
  });

  test("source 支持单个与多个，event/search 子串匹配", () => {
    clearAppLog();
    logEvent({ source: "image", event: "image.generate.failed", message: "生图失败" });
    logEvent({ source: "video", event: "video.submit.failed", message: "视频提交失败" });
    logEvent({ source: "server", event: "served_model.crashed", message: "进程退出" });

    expect(readAppLogsInMemory({ source: "image" })).toHaveLength(1);
    expect(readAppLogsInMemory({ source: ["image", "video"] })).toHaveLength(2);
    expect(readAppLogsInMemory({ event: "generate.failed" })).toHaveLength(1);
    expect(readAppLogsInMemory({ search: "提交" })).toHaveLength(1);
    expect(readAppLogsInMemory({ search: "服务" })).toHaveLength(0);
  });

  test("默认倒序（新的在前），oldestFirst 反转", () => {
    clearAppLog();
    logEvent({ source: "app", event: "first", message: "1" });
    logEvent({ source: "app", event: "second", message: "2" });

    expect(readAppLogsInMemory().map((e) => e.event)).toEqual(["second", "first"]);
    expect(readAppLogsInMemory({ oldestFirst: true }).map((e) => e.event)).toEqual(["first", "second"]);
  });

  test("limit 生效", () => {
    clearAppLog();
    for (let i = 0; i < 10; i++) logEvent({ source: "app", event: `e${i}`, message: String(i) });
    expect(readAppLogsInMemory({ limit: 3 })).toHaveLength(3);
  });

  test("limit 取的是**最新**的 N 条，oldestFirst 只影响显示顺序", () => {
    clearAppLog();
    for (let i = 0; i < 10; i++) logEvent({ source: "app", event: `e${i}`, message: String(i) });

    // 倒序：最新在前
    expect(readAppLogsInMemory({ limit: 3 }).map((e) => e.event)).toEqual(["e9", "e8", "e7"]);
    // 正序：还是这最新 3 条，只是老的在前 —— 不能变成 e0/e1/e2（那是上上次的现场）
    expect(readAppLogsInMemory({ limit: 3, oldestFirst: true }).map((e) => e.event)).toEqual(["e7", "e8", "e9"]);
  });

  test("search 也匹配事件名（搜 builtin 能找到 skills.builtin.seeded）", () => {
    clearAppLog();
    logEvent({ source: "skills", event: "skills.builtin.seeded", message: "内置技能：新装 1 个" });
    logEvent({ source: "app", event: "app.start", message: "主进程启动" });

    expect(readAppLogsInMemory({ search: "builtin" }).map((e) => e.event)).toEqual(["skills.builtin.seeded"]);
    expect(readAppLogsInMemory({ search: "主进程" }).map((e) => e.event)).toEqual(["app.start"]);
  });
});

describe("脱敏与截断（日志泄漏密钥比没有日志更糟）", () => {
  test("常见密钥字段一律替换", () => {
    const clean = sanitizeValue({
      apiKey: "sk-live-123",
      api_key: "sk-live-456",
      token: "t",
      secret: "s",
      password: "p",
      Authorization: "Bearer x",
      cookie: "a=b",
      nested: { IMG_API_KEY: "sk-nested" },
      keep: "visible",
    }) as Record<string, unknown>;

    expect(clean.apiKey).toBe("***");
    expect(clean.api_key).toBe("***");
    expect(clean.token).toBe("***");
    expect(clean.secret).toBe("***");
    expect(clean.password).toBe("***");
    expect(clean.Authorization).toBe("***");
    expect(clean.cookie).toBe("***");
    expect((clean.nested as Record<string, unknown>).IMG_API_KEY).toBe("***");
    expect(clean.keep).toBe("visible");
  });

  test("空值保持空值（不把「没配」写成『配了』）", () => {
    const clean = sanitizeValue({ apiKey: "", token: null }) as Record<string, unknown>;
    expect(clean.apiKey).toBe("");
    expect(clean.token).toBe(null);
  });

  test("落盘内容里不含密钥明文", () => {
    clearAppLog();
    logEvent({
      source: "image",
      event: "image.generate.failed",
      message: "401 Unauthorized",
      detail: { apiBase: "https://api.example.com/v1", apiKey: "sk-super-secret", hasApiKey: true },
    });
    const raw = readFileSync(appLogPath(), "utf8");
    expect(raw).not.toContain("sk-super-secret");
    expect(raw).toContain("***");
    expect(raw).toContain("api.example.com");
  });

  test("Error 转成 name/message/stack，循环引用不炸", () => {
    const err = new Error("boom");
    const cyclic: Record<string, unknown> = { err };
    cyclic.self = cyclic;
    const clean = sanitizeValue(cyclic) as Record<string, unknown>;
    expect((clean.err as Record<string, unknown>).message).toBe("boom");
    expect(clean.self).toBe("[循环引用]");
  });

  test("超长字符串截断而非整段丢弃", () => {
    const long = "x".repeat(5000);
    const clean = sanitizeValue(long) as string;
    expect(clean.length).toBeLessThan(long.length);
    expect(clean).toContain("已截断");
  });

  test("detail 再大也是有界的（单字段先截断）", () => {
    clearAppLog();
    const entry = logEvent({
      source: "video",
      event: "big",
      message: "big detail",
      detail: { blob: "y".repeat(20_000) },
    });
    const serialized = JSON.stringify(entry.detail);
    expect(serialized.length).toBeLessThan(6000);
    expect(serialized).toContain("已截断");
  });

  test("字段多到超过总量上限时退化成 preview", () => {
    clearAppLog();
    const wide: Record<string, string> = {};
    for (let i = 0; i < 40; i++) wide[`field${i}`] = "z".repeat(1500);
    const entry = logEvent({ source: "video", event: "wide", message: "wide detail", detail: wide });
    const serialized = JSON.stringify(entry.detail);
    expect(serialized.length).toBeLessThan(6000);
    expect(serialized).toContain("_truncated");
  });
});

describe("健壮性", () => {
  test("不抛错：消息里的异常值也能落盘", () => {
    expect(() => logEvent({ source: "app", event: "weird", message: undefined as never })).not.toThrow();
    expect(() => logEvent({ source: "app", event: "weird2", message: "x", detail: undefined })).not.toThrow();
  });

  test("文件不存在时读盘返回空数组（应用没跑过也不报错）", () => {
    clearAppLog();
    expect(readAppLogFiles({ limit: 5 })).toEqual([]);
  });

  test("未知来源也能写（webview 上报的 source 不受联合类型限制）", () => {
    clearAppLog();
    const entry = logEvent({ source: "notice" as never, event: "x", message: "y" });
    expect(entry.source).toBe("notice");
  });
});
