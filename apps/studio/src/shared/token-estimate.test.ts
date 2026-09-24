import { describe, expect, test } from "bun:test";

import { estimateMessagesTokens, estimateTokens } from "./token-estimate";

/**
 * toolCall 分块必须按「工具名 + 参数序列化」计 token：写文件这类调用参数可以上千
 * token，只算 `[toolCall]` 两个字会低估一个数量级，摘要/压缩因此错过触发时机。
 */
describe("toolCall 分块的 token 估算", () => {
  const bigContent = "const x = 1;\n".repeat(120); // 一行重复 120 遍 ≈ 1500 字符

  test("大参数工具调用：估算值不小于参数内容单独估算的值", () => {
    const tokens = estimateMessagesTokens([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "write_file", arguments: { path: "a.ts", content: bigContent } }],
      },
    ]);
    expect(tokens).toBeGreaterThanOrEqual(estimateTokens(bigContent));
  });

  test("参数里的中文按中文口径计入", () => {
    const cn = "这是一个很长的中文参数内容，用来验证估算不会把中文丢掉。".repeat(8);
    const tokens = estimateMessagesTokens([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "t2", name: "write_file", arguments: { content: cn } }],
      },
    ]);
    expect(tokens).toBeGreaterThanOrEqual(estimateTokens(cn));
  });

  test("工具名也计入：名字越长估算值越大", () => {
    const short = estimateMessagesTokens([
      { role: "assistant", content: [{ type: "toolCall", id: "t3", name: "abc", arguments: { a: 1 } }] },
    ]);
    const long = estimateMessagesTokens([
      { role: "assistant", content: [{ type: "toolCall", id: "t3", name: "abcdefghijklmno", arguments: { a: 1 } }] },
    ]);
    expect(long).toBeGreaterThan(short);
  });

  test("缺 name / 缺 arguments 时不抛错，且仍计一个正数", () => {
    const tokens = estimateMessagesTokens([{ role: "assistant", content: [{ type: "toolCall" }] }]);
    expect(tokens).toBeGreaterThan(0);
  });

  test("老行为不变：字符串 content、text 分块、非 toolCall 分块", () => {
    // 字符串："hello world" 11 字符 → 3
    expect(estimateMessagesTokens([{ role: "user", content: "hello world" }])).toBe(3);
    // 带 text 的分块：3（"读文件" = 3 个 CJK 字）
    expect(estimateMessagesTokens([{ role: "assistant", content: [{ type: "text", text: "读文件" }] }])).toBe(3);
    // 非 toolCall、无 text 的分块：只算类型占位 "[toolResult]"（12 字符 → 3）
    expect(
      estimateMessagesTokens([{ role: "tool", content: [{ type: "toolResult", id: "t9" }] }]),
    ).toBe(3);
  });
});
