import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { buildAgentTools, type BuiltTool, type ToolContext } from "./agent-tools";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "omni-agent-tools-edit-"));
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

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content
    .map((part) => part.text ?? "")
    .join("\n");
}

async function editFile(
  file: string,
  body: string,
  params: { old_str: string; new_str: string; replace_all?: boolean },
): Promise<{ text: string; content: string }> {
  writeFileSync(path.join(workspace, file), body, "utf8");
  const tools = buildAgentTools(ctx);
  const result = await tool(tools, "edit_file").execute("t1", { path: file, ...params });
  return { text: textOf(result), content: readFileSync(path.join(workspace, file), "utf8") };
}

describe("edit_file 工具", () => {
  test("new_str 含 $& 时按字面落盘，不展开替换模式", async () => {
    const { text, content } = await editFile("a.txt", "AAA", { old_str: "AAA", new_str: "x$&y" });
    expect(text).not.toContain("failed");
    expect(content).toBe("x$&y");
  });

  test("new_str 含 $$ 和 $` 与 $' 时按字面落盘", async () => {
    const withTicks = "a$$b`c$'";
    const { text, content } = await editFile("b.txt", "AAA", { old_str: "AAA", new_str: withTicks });
    expect(text).not.toContain("failed");
    expect(content).toBe(withTicks);
  });

  test("old_str 为空时返回错误且不写文件", async () => {
    const before = "unchanged body\n";
    writeFileSync(path.join(workspace, "c.txt"), before, "utf8");
    const tools = buildAgentTools(ctx);
    const result = await tool(tools, "edit_file").execute("t1", {
      path: "c.txt",
      old_str: "",
      new_str: "X",
      replace_all: true,
    });
    expect(textOf(result)).toContain("old_str 不能为空");
    expect(readFileSync(path.join(workspace, "c.txt"), "utf8")).toBe(before);
  });

  test("正常单次替换仍然正确", async () => {
    const { text, content } = await editFile(
      "d.txt",
      "const version = 1;\nconst other = 2;\n",
      { old_str: "const version = 1;", new_str: "const version = 2;" },
    );
    expect(text).toContain("Edited");
    expect(content).toBe("const version = 2;\nconst other = 2;\n");
  });

  test("replace_all=true 且 new_str 含 $& 时仍然正确", async () => {
    const { text, content } = await editFile("e.txt", "AAA BBB AAA", {
      old_str: "AAA",
      new_str: "x$&y",
      replace_all: true,
    });
    expect(text).toContain("Edited");
    expect(content).toBe("x$&y BBB x$&y");
  });
});
