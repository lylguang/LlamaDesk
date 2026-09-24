import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import {
  MAX_SPILLS_PER_CONVERSATION,
  MAX_TOOL_RESULT_CHARS,
  MAX_TOOL_OUTPUT_CHARS,
  capToolResultText,
  clearConversationSpills,
  conversationSpillDir,
  isSpillPath,
  pruneSpills,
  spillRoot,
  spillToolOutput,
  toolOutputCharLimit,
  truncateForModel,
} from "./agent-spill";

describe("truncateForModel", () => {
  test("没超限就原样返回", () => {
    const result = truncateForModel("短输出");
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("短输出");
  });

  test("超限时写清三件事：被截了、还差多少、去哪儿找原文", () => {
    const text = "x".repeat(MAX_TOOL_OUTPUT_CHARS + 500);
    const result = truncateForModel(text, { spillPath: "/data/tool-output/7/a.txt" });
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("输出被截断");
    expect(result.text).toContain("500 个字符");
    expect(result.text).toContain("不要");
    expect(result.text).toContain("/data/tool-output/7/a.txt");
    expect(result.text).toContain("read_file");
    // 前半段必须原样保留：模型要基于它继续推理。
    expect(result.text.startsWith(text.slice(0, 100))).toBe(true);
  });

  test("超限时保留尾部（bash 的失败清单和统计都在结尾）", () => {
    const text = `START-MARKER\n${"m".repeat(400)}\nEND-MARKER`;
    const result = truncateForModel(text, { maxChars: 100 });
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("END-MARKER");
  });

  test("头部仍在最前，结果以原文开头", () => {
    const text = `START-MARKER\n${"m".repeat(400)}\nEND-MARKER`;
    const result = truncateForModel(text, { maxChars: 100 });
    expect(result.text.startsWith("START-MARKER")).toBe(true);
  });

  test("中间省略说明里带着正确的省略字符数", () => {
    const text = `START-MARKER\n${"m".repeat(400)}\nEND-MARKER`;
    const result = truncateForModel(text, { maxChars: 100 });
    expect(result.text).toContain(`省略了约 ${text.length - 100} 个字符`);
  });

  test("头尾两段合计正好等于 max，不多占窗口（多个 max 值）", () => {
    const text = `START-MARKER\n${"m".repeat(400)}\nEND-MARKER`;
    for (const max of [1, 2, 10, 100]) {
      const head = Math.floor(max * 0.7);
      const result = truncateForModel(text, { maxChars: max });
      expect(result.truncated).toBe(true);
      // 中间说明永远存在（它把两段原文隔开），找它前后的边界。
      const midStart = result.text.indexOf("…（中间省略");
      const markerEnd = result.text.indexOf("\n…（输出被截断");
      expect(midStart).toBeGreaterThanOrEqual(0);
      expect(markerEnd).toBeGreaterThan(0);
      const headPart = result.text.slice(0, head);
      let tailPart = result.text
        .slice(midStart, markerEnd)
        .replace(/^…（中间省略了约 \d+ 个字符）…\n?/, "")
        .replace(/\n$/, "");
      expect(headPart).toBe(text.slice(0, head));
      expect(tailPart).toBe(max - head > 0 ? text.slice(-(max - head)) : "");
      expect(headPart.length + tailPart.length).toBe(max);
    }
  });

  test("maxChars 为 0 时不返回任何原文内容（text.slice(-0) 会吐出整段）", () => {
    const text = `START-MARKER\n${"m".repeat(400)}\nEND-MARKER`;
    const result = truncateForModel(text, { maxChars: 0 });
    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain("START-MARKER");
    expect(result.text).not.toContain("END-MARKER");
  });

  test("maxChars 为负数时同样不返回原文内容", () => {
    const text = `START-MARKER\n${"m".repeat(400)}\nEND-MARKER`;
    const result = truncateForModel(text, { maxChars: -50 });
    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain("START-MARKER");
    expect(result.text).not.toContain("END-MARKER");
  });

  test("头部不占满额度：尾部标记不能被头部挤掉（比例不能等于 1）", () => {
    const text = `START-MARKER\n${"m".repeat(400)}\nEND-MARKER`;
    const max = 100;
    const result = truncateForModel(text, { maxChars: max });
    expect(result.text.length).toBeLessThan(text.length);
    expect(result.text.lastIndexOf("END-MARKER")).toBeGreaterThan(Math.floor(max * 0.7) + 10);
  });

  test("转存失败（没有路径）时退化成旧文案，但不撒谎说原文还在", () => {
    const text = "y".repeat(MAX_TOOL_OUTPUT_CHARS + 1);
    const result = truncateForModel(text, { spillPath: null });
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("输出被截断");
    expect(result.text).not.toContain("已经存到");
    // 仍然给出可执行的下一步（缩小范围重试）。
    expect(result.text).toContain("grep");
  });
});

describe("capToolResultText", () => {
  test("硬上限之内原样返回", () => {
    expect(capToolResultText("abc")).toBe("abc");
  });

  test("超过内存硬上限时丢尾部并说明原因（bash 输出在读之前不知道有多大）", () => {
    const huge = "z".repeat(1000);
    const capped = capToolResultText(huge, 100);
    expect(capped.startsWith("z".repeat(100))).toBe(true);
    expect(capped).toContain("输出过大");
    expect(capped.length).toBeLessThan(huge.length);
  });

  test("默认硬上限比展示上限大两个量级（先落盘、再截断给模型看）", () => {
    expect(MAX_TOOL_RESULT_CHARS).toBeGreaterThan(MAX_TOOL_OUTPUT_CHARS * 10);
  });
});

describe("spillToolOutput", () => {
  test("写到会话目录、能原样读回，并带上工具名", () => {
    const text = `完整输出 ${"x".repeat(50)}`;
    const spill = spillToolOutput({ conversationId: 91_001, toolName: "bash", text });
    expect(spill).not.toBeNull();
    expect(spill!.path.startsWith(conversationSpillDir(91_001))).toBe(true);
    expect(spill!.path).toContain("bash");
    expect(spill!.path.endsWith(".txt")).toBe(true);
    expect(readFileSync(spill!.path, "utf8")).toBe(text);
    expect(spill!.truncated).toBe(false);
    clearConversationSpills(91_001);
    expect(existsSync(spill!.path)).toBe(false);
  });

  test("工具名进文件名前消毒（含路径分隔符也不会跑出目录）", () => {
    const spill = spillToolOutput({
      conversationId: 91_002,
      toolName: "../../etc/passwd",
      text: "hi",
    });
    expect(spill).not.toBeNull();
    expect(spill!.path.startsWith(conversationSpillDir(91_002))).toBe(true);
    expect(spill!.path).not.toContain("..");
    clearConversationSpills(91_002);
  });

  test("超过写盘上限时截断，并在结果里如实标注", () => {
    const spill = spillToolOutput({
      conversationId: 91_003,
      toolName: "bash",
      text: "a".repeat(50),
      maxBytes: 10,
    });
    expect(spill!.truncated).toBe(true);
    expect(readFileSync(spill!.path, "utf8")).toBe("a".repeat(10));
    clearConversationSpills(91_003);
  });

  test("只保留最近 N 个转存文件", () => {
    const dir = conversationSpillDir(91_004);
    const written: string[] = [];
    for (let index = 0; index < MAX_SPILLS_PER_CONVERSATION + 5; index += 1) {
      // 文件名以时间戳开头，同一毫秒内会重名 —— 这里靠循环里的小延迟拉开。
      const spill = spillToolOutput({
        conversationId: 91_004,
        toolName: `tool${index}`,
        text: String(index),
      });
      written.push(spill!.path);
      Bun.sleepSync(2);
    }
    const kept = readdirSync(dir).filter((name) => name.endsWith(".txt"));
    expect(kept.length).toBeLessThanOrEqual(MAX_SPILLS_PER_CONVERSATION);
    // 最新的那个一定还在（清理只针对更早的）。
    expect(existsSync(written[written.length - 1]!)).toBe(true);
    clearConversationSpills(91_004);
  });

  test("目录里没有 .txt 时清理不动手", () => {
    expect(pruneSpills("/definitely/not/a/dir")).toBe(0);
  });
});

describe("isSpillPath（那两处窄口子的边界）", () => {
  test("字面在转存目录里就算（写之前文件还不存在）", () => {
    const dir = conversationSpillDir(91_777);
    mkdirSync(dir, { recursive: true });
    try {
      expect(isSpillPath(path.join(dir, "还没写出来的.txt"))).toBe(true);
      expect(isSpillPath(dir)).toBe(true);
    } finally {
      clearConversationSpills(91_777);
    }
  });

  test("目录外的路径不算，别处也不被认成转存", () => {
    expect(isSpillPath("/tmp/whatever.txt")).toBe(false);
    expect(isSpillPath(path.join(spillRoot(), "..", "settings.db"))).toBe(false);
  });

  test("软链接指向凭据文件时不算：否则三道门一起被绕过", () => {
    // `tool-output/<会话>/x` 若是软链，光比字面路径会放行：凭据黑名单
    // （agent-tools）、工作区外读取授权（permissions）本来都靠这个函数开口子，
    // 于是"看起来在转存目录里"变成一张通行证。bash 工具自己就能建这个软链。
    const dir = conversationSpillDir(91_778);
    mkdirSync(dir, { recursive: true });
    const secret = path.join(tmpdir(), `omni-not-secret-${process.pid}.txt`);
    writeFileSync(secret, "凭据");
    const link = path.join(dir, "sneaky.txt");
    try {
      rmSync(link, { force: true });
      symlinkSync(secret, link);
      expect(isSpillPath(link)).toBe(false);
      // 会话目录本身指向别处（整目录替换）同样不算。
      const linkedDir = path.join(spillRoot(), "91_779");
      rmSync(linkedDir, { recursive: true, force: true });
      symlinkSync(tmpdir(), linkedDir);
      expect(isSpillPath(path.join(linkedDir, "x.txt"))).toBe(false);
    } finally {
      rmSync(link, { force: true });
      rmSync(path.join(spillRoot(), "91_779"), { force: true });
      rmSync(secret, { force: true });
      clearConversationSpills(91_778);
    }
  });
});

describe("toolOutputCharLimit（单条工具输出随窗口缩放）", () => {
  test("8192 窗口算出 6144（8k 窗口下单条工具结果不能吃掉大半个窗口）", () => {
    expect(toolOutputCharLimit(8192)).toBe(6144);
  });

  test("大窗口被 MAX_TOOL_OUTPUT_CHARS 夹住（窗口再大也不放宽）", () => {
    expect(toolOutputCharLimit(131_072)).toBe(MAX_TOOL_OUTPUT_CHARS);
  });

  test("小窗口被下限夹住：再小的窗口也要让模型看到一点东西", () => {
    expect(toolOutputCharLimit(1024)).toBe(2000);
  });

  test("非法值（0、负数、NaN、Infinity）退回 MAX_TOOL_OUTPUT_CHARS", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(toolOutputCharLimit(bad)).toBe(MAX_TOOL_OUTPUT_CHARS);
    }
  });
});
