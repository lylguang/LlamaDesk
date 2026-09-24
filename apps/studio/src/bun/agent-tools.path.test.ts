import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { assertReadable, assertWritable, type ToolContext } from "./agent-tools";

/**
 * 工作区归属判定（软链）：工作区里放一个指向区外的软链，字面路径仍在区内，
 * 凭据黑名单与区外授权会被一起跳过 —— 而 bash 工具自己就能建这个软链。
 */

let workspace: string;
let outside: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "omni-agent-path-ws-"));
  // 「假凭据目录」：另建一个临时目录并放一个文件，不用真的 ~/.ssh。
  outside = mkdtempSync(path.join(tmpdir(), "omni-agent-path-secret-"));
  writeFileSync(path.join(outside, "key.txt"), "fake-credential");
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const ctx: ToolContext = {
  get workspace() {
    return workspace;
  },
  allowShell: false,
} as ToolContext;

describe("工作区归属判定（解软链）", () => {
  test("区内指向区外凭据目录的软链，读取被拒", () => {
    symlinkSync(outside, path.join(workspace, "leak"));
    expect(() => assertReadable(ctx, path.join(workspace, "leak"))).toThrow();
  });

  test("区内指向区外的软链，写入被拒", () => {
    symlinkSync(outside, path.join(workspace, "leak"));
    expect(() => assertWritable(ctx, path.join(workspace, "leak"))).toThrow();
  });

  test("区内真实文件与目录照常放行", () => {
    writeFileSync(path.join(workspace, "a.txt"), "hello\n");
    mkdirSync(path.join(workspace, "sub"), { recursive: true });
    expect(() => assertReadable(ctx, path.join(workspace, "a.txt"))).not.toThrow();
    expect(() => assertWritable(ctx, path.join(workspace, "a.txt"))).not.toThrow();
    expect(() => assertReadable(ctx, path.join(workspace, "sub"))).not.toThrow();
    expect(() => assertWritable(ctx, path.join(workspace, "sub"))).not.toThrow();
  });

  test("尚未创建的新文件路径照常放行（写新文件不能因为路径不存在被拒）", () => {
    expect(() => assertWritable(ctx, path.join(workspace, "brand-new.txt"))).not.toThrow();
    expect(() => assertReadable(ctx, path.join(workspace, "never-existed.txt"))).not.toThrow();
  });
});
