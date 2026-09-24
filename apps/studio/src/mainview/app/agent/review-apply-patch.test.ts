import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { mock } from "bun:test";

/**
 * 补丁输入下的两个纯函数（apply_patch 是 agent 改代码的首选工具）：
 *
 * 1. `patchFilePaths`：审查页签靠它把「一个补丁改了哪些文件」摊进会话改动列表
 *    （工作区不是 git 仓库时的回落，见 review-tab.tsx）——补丁参数里没有 `path`，
 *    取不到全部文件名，最主要的改动来源就整个不出现在审查列表里。
 * 2. `summarizeEdit`：时间轴的编辑摘要靠它算出补丁的 +/- 行数。
 *
 * 纯函数、不需要 DOM 断言；但 `timeline.tsx` 间接 import `@stores/ui-lang`，
 * 其底层 `electrobun/view` 在模块加载时就读 `window`，所以先把最小 happy-dom
 * 全局装好再 import（只借它的加载环境，不渲染、不搭测试脚手架）。
 */
const dom = new Window({ url: "http://localhost/" });
const savedGlobals = new Map<string, unknown>();
for (const key of ["window", "document", "navigator"] as const) {
  const value = (dom as unknown as Record<string, unknown>)[key];
  if (value === undefined) continue;
  savedGlobals.set(key, (globalThis as unknown as Record<string, unknown>)[key]);
  (globalThis as unknown as Record<string, unknown>)[key] = value;
}

// timeline.tsx 的 InlinePermissionCard 会连带加载 RPC 客户端，这里给个空壳即可。
mock.module("@lib/rpc", () => ({ rpcClient: {} }));

const { patchFilePaths, summarizeEdit } = await import("./timeline");
const { collectSessionChanges } = await import("./review-tab");

type ToolStartEvent = { kind: string; toolName?: string | null; args?: string | null };

/** Add / Update / Delete 三种段落头各来一个的补丁。 */
const MULTI_PATCH = [
  "*** Begin Patch",
  "*** Add File: src/a.ts",
  "+export const a = 1;",
  "*** Update File: src/b.ts",
  "@@",
  " context",
  "-export const b = 1;",
  "+export const b = 2;",
  "+export const b2 = 3;",
  "*** Delete File: src/c.ts",
  "-export const c = 1;",
  "-export const c2 = 2;",
  "*** End Patch",
].join("\n");

describe("patchFilePaths（审查页签登记补丁改动文件）", () => {
  test("能从一份多文件补丁里取出全部文件名（Add / Update / Delete 各一）", () => {
    expect(patchFilePaths(MULTI_PATCH)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  test("对不含段落头的文本返回空数组（不误报）", () => {
    expect(patchFilePaths("hello world\nno marker here")).toEqual([]);
    expect(patchFilePaths("")).toEqual([]);
  });
});

describe("summarizeEdit（时间轴编辑摘要对补丁算 +/- 行数）", () => {
  test("补丁参数算得出增删行数，且 +++ / --- 头不被算进去", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: x/y.ts",
      "--- a/x/y.ts",
      "+++ b/x/y.ts",
      "@@ -1 +1,2 @@",
      " context line",
      "-old line 1",
      "-old line 2",
      "+new line 1",
      "+new line 2",
      "+new line 3",
      "*** End Patch",
    ].join("\n");
    const summary = summarizeEdit(JSON.stringify({ patch }));
    expect(summary).not.toBeNull();
    expect(summary!.added).toBe(3);
    expect(summary!.removed).toBe(2);
  });

  test("write_file / edit_file 的参数行为不变（防止改动波及旧路径）", () => {
    const written = summarizeEdit(JSON.stringify({ content: "a\nb\nc" }));
    expect(written).not.toBeNull();
    expect(written!.added).toBe(3);
    expect(written!.removed).toBe(0);

    const edited = summarizeEdit(JSON.stringify({ old_str: "x\ny", new_str: "x\nz\nw" }));
    expect(edited).not.toBeNull();
    expect(edited!.added).toBe(2); // z, w
    expect(edited!.removed).toBe(1); // y
  });
});

/** 只改一个文件的补丁（+2 / -1）。 */
const SINGLE_PATCH = [
  "*** Begin Patch",
  "*** Update File: src/one.ts",
  "@@ -1 +1,2 @@",
  " context",
  "-old line",
  "+new line 1",
  "+new line 2",
  "*** End Patch",
].join("\n");

describe("collectSessionChanges（审查页签「会话改动」的累计）", () => {
  test("单文件补丁：文件登记、增删行数是准确值（不是近似）", () => {
    const events: ToolStartEvent[] = [
      { kind: "tool_start", toolName: "apply_patch", args: JSON.stringify({ patch: SINGLE_PATCH }) },
    ];
    const changes = collectSessionChanges(events);
    expect(changes).toEqual([{ path: "src/one.ts", added: 2, removed: 1, tool: "apply_patch" }]);
  });

  test("多文件补丁：三个文件都登记，tool 是 apply_patch，行数按合计除以 3 向上取整", () => {
    const events: ToolStartEvent[] = [
      { kind: "tool_start", toolName: "apply_patch", args: JSON.stringify({ patch: MULTI_PATCH }) },
    ];
    const changes = collectSessionChanges(events);
    // 整份补丁合计 +3 / -3，均摊到 3 个文件：每个文件 ceil(3/3)=1 / ceil(3/3)=1。
    expect(changes.map((c) => c.path)).toEqual(["src/c.ts", "src/b.ts", "src/a.ts"]);
    for (const change of changes) {
      expect(change.tool).toBe("apply_patch");
      expect(change.added).toBe(1);
      expect(change.removed).toBe(1);
    }
  });

  test("write_file / edit_file 的老路径不变", () => {
    const events: ToolStartEvent[] = [
      { kind: "tool_start", toolName: "write_file", args: JSON.stringify({ path: "f/new.ts", content: "a\nb\nc" }) },
      { kind: "tool_start", toolName: "edit_file", args: JSON.stringify({ path: "f/old.ts", old_str: "x\ny", new_str: "x\nz\nw" }) },
    ];
    const changes = collectSessionChanges(events);
    expect(changes).toEqual([
      { path: "f/old.ts", added: 2, removed: 1, tool: "edit_file" },
      { path: "f/new.ts", added: 3, removed: 0, tool: "write_file" },
    ]);
  });

  test("坏参数不炸：非法 JSON 在补丁与非补丁两条路径上都正常返回", () => {
    const events: ToolStartEvent[] = [
      { kind: "tool_start", toolName: "apply_patch", args: "{" },
      { kind: "tool_start", toolName: "write_file", args: "{" },
      { kind: "tool_start", toolName: "edit_file", args: "{" },
      // 对照：同一批里一条好参数照样登记（证明不是整批被跳过）。
      { kind: "tool_start", toolName: "write_file", args: JSON.stringify({ path: "f/good.ts", content: "a\nb" }) },
    ];
    const changes = collectSessionChanges(events);
    expect(changes).toEqual([{ path: "f/good.ts", added: 2, removed: 0, tool: "write_file" }]);
  });

  test("非 tool_start 事件、以及别的工具名（bash）被跳过", () => {
    const events: ToolStartEvent[] = [
      { kind: "text", toolName: "write_file", args: JSON.stringify({ path: "t/1.ts", content: "a\nb" }) },
      { kind: "tool_end", toolName: "write_file", args: JSON.stringify({ path: "t/2.ts", content: "a\nb" }) },
      { kind: "tool_start", toolName: "bash", args: JSON.stringify({ command: "ls" }) },
      { kind: "tool_start", toolName: "read_file", args: JSON.stringify({ path: "t/3.ts" }) },
      // 对照：一条正常的 tool_start 编辑事件仍在。
      { kind: "tool_start", toolName: "edit_file", args: JSON.stringify({ path: "t/ok.ts", old_str: "a", new_str: "b\nc" }) },
    ];
    const changes = collectSessionChanges(events);
    expect(changes).toEqual([{ path: "t/ok.ts", added: 2, removed: 1, tool: "edit_file" }]);
  });
});
