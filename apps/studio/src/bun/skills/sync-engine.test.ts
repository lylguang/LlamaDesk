/**
 * 同步 / 卸载的 id 边界：skillId 从 webview 一路传到这里，`../..` 会让
 * "同步技能"把软链 / 拷贝写到中央库外，卸载与重推还会先递归删目标目录。
 * 只测拒绝路径——成功路径会真的往 ~/.claude/skills 之类的地方写入，不能在单测里跑。
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const central = mkdtempSync(join(tmpdir(), "skills-sync-central-"));
const outside = mkdtempSync(join(tmpdir(), "skills-sync-outside-"));
writeFileSync(join(outside, "keep.txt"), "KEEP");

const { setCentralRepoPath } = await import("./central-repo");
setCentralRepoPath(central);
const { syncSkillToTool, unsyncSkillFromTool, targetConflicts } = await import("./sync-engine");

mkdirSync(join(central, "good-skill"), { recursive: true });

afterAll(() => {
  rmSync(central, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("越界 skillId 在触碰文件系统之前就被拒", () => {
  for (const bad of ["../../keep.txt", "../..", "/tmp", "a/b"]) {
    const sync = syncSkillToTool(bad, "claude_code");
    expect(sync.ok).toBe(false);
    expect(sync.error).toContain("非法的技能 id");

    const unsync = unsyncSkillFromTool(bad, "claude_code");
    expect(unsync.ok).toBe(false);
    expect(unsync.error).toContain("非法的技能 id");

    expect(targetConflicts(bad, "claude_code")).toBe(false);
  }
  // 中央库外的东西一个都没被动过。
  expect(existsSync(join(outside, "keep.txt"))).toBe(true);
});

test("中央库外的目录不会被当成技能源", () => {
  // 合法但库里没有的 id：报"目录不存在"，而不是去别处找。
  const missing = syncSkillToTool("no-such-skill", "claude_code");
  expect(missing.ok).toBe(false);
  expect(missing.error).toBe("skill dir missing");
});
