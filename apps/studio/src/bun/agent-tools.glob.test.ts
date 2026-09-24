import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { buildAgentTools, type BuiltTool, type ToolContext } from "./agent-tools";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "omni-agent-tools-"));
  writeFileSync(path.join(workspace, "a.ts"), "export const a = 1;\n");
  writeFileSync(path.join(workspace, "b.ts"), "export const b = 2;\n");
  writeFileSync(path.join(workspace, "c.ts"), "export const c = 3;\n");
  writeFileSync(path.join(workspace, "ab.ts"), "export const ab = 1;\n");
  writeFileSync(path.join(workspace, "readme.md"), "# readme\n");
  mkdirSync(path.join(workspace, "src"));
  writeFileSync(path.join(workspace, "src", "b.ts"), "export const b = 4;\n");
  writeFileSync(path.join(workspace, "src", "ab.ts"), "export const ab = 5;\n");
  mkdirSync(path.join(workspace, "src", "deep"));
  writeFileSync(path.join(workspace, "src", "deep", "c.ts"), "export const c = 6;\n");
  writeFileSync(path.join(workspace, "src", "deep", "d.test.ts"), "export const d = 7;\n");
  mkdirSync(path.join(workspace, "x"));
  writeFileSync(path.join(workspace, "x", "c.ts"), "export const xc = 8;\n");
  mkdirSync(path.join(workspace, "src", "x"));
  writeFileSync(path.join(workspace, "src", "x", "c.ts"), "export const srcxc = 9;\n");
  mkdirSync(path.join(workspace, "ax"));
  writeFileSync(path.join(workspace, "ax", "c.ts"), "export const axc = 10;\n");
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const ctx: ToolContext = {
  get workspace() {
    return workspace;
  },
  allowShell: false,
} as ToolContext;

function tool(tools: BuiltTool[], name: string): BuiltTool {
  const found = tools.find((item) => item.name === name);
  if (!found) throw new Error(`tool not found: ${name}`);
  return found;
}

async function globMatches(pattern: string): Promise<string[]> {
  const result = await tool(buildAgentTools(ctx), "glob").execute("t1", { pattern });
  return textOf(result)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line !== "(no matches)")
    .sort();
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content
    .map((part) => part.text ?? "")
    .join("\n");
}

describe("glob 工具的 ** 语义", () => {
  test("**/*.ts 匹配根层文件 a.ts", async () => {
    const matches = await globMatches("**/*.ts");
    expect(matches).toContain("a.ts");
  });

  test("**/*.ts 同时匹配 src/b.ts 和 src/deep/c.ts", async () => {
    const matches = await globMatches("**/*.ts");
    expect(matches).toContain("src/b.ts");
    expect(matches).toContain("src/deep/c.ts");
  });

  test("**/*.ts 不匹配 readme.md", async () => {
    const matches = await globMatches("**/*.ts");
    expect(matches).not.toContain("readme.md");
  });

  test("src/**/*.test.ts 匹配 src/deep/d.test.ts", async () => {
    const matches = await globMatches("src/**/*.test.ts");
    expect(matches).toContain("src/deep/d.test.ts");
  });

  test("单个 *.ts 只匹配根层，不跨目录", async () => {
    const matches = await globMatches("*.ts");
    expect(matches).toContain("a.ts");
    expect(matches).not.toContain("src/b.ts");
    expect(matches).not.toContain("src/deep/c.ts");
  });

  test("? 仍然只匹配单个字符", async () => {
    const matches = await globMatches("a?.ts");
    expect(matches).toContain("ab.ts");
    expect(matches).not.toContain("a.ts");
  });

  test("**/b.ts 前缀必须在斜杠处结束，不匹配 src/ab.ts", async () => {
    const matches = await globMatches("**/b.ts");
    expect(matches).toContain("b.ts");
    expect(matches).toContain("src/b.ts");
    expect(matches).not.toContain("src/ab.ts");
  });

  test("**/x/*.ts 目录段必须完整，不匹配 ax/c.ts", async () => {
    const matches = await globMatches("**/x/*.ts");
    expect(matches).toContain("x/c.ts");
    expect(matches).toContain("src/x/c.ts");
    expect(matches).not.toContain("ax/c.ts");
  });
});
