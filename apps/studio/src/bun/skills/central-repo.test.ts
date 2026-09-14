/**
 * 技能的 id 校验：skillId 会从 webview（同步 / 卸载 / 读文档 / 打开目录）、DB 行、
 * 远端仓库一路流到文件系统，任何一处拼 `../..` 都可能把"同步技能"变成对中央库外
 * 任意目录的软链替换或递归删除。这里盯住解析入口 centralSkillDir 与用到它的读文档路径。
 *
 * 不做模块 mock：bunfig 的 test-preload 已把数据目录指向本进程专属的临时目录。
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const central = mkdtempSync(join(tmpdir(), "skills-central-"));
const outside = mkdtempSync(join(tmpdir(), "skills-outside-"));

const { setCentralRepoPath, getCentralRepoDir, centralSkillDir } = await import("./central-repo");
setCentralRepoPath(central);
const { getSkillDoc } = await import("./index");

mkdirSync(join(central, "good-skill"), { recursive: true });
writeFileSync(join(central, "good-skill", "SKILL.md"), "# Good\n");
// 中央库外面的一份同名文档：越界引用绝不能读到它。
writeFileSync(join(outside, "secret.txt"), "TOP-SECRET");

afterAll(() => {
  rmSync(central, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("centralSkillDir 只接受中央库下的单层目录名", () => {
  expect(getCentralRepoDir()).toBe(central);
  expect(centralSkillDir("good-skill")).toBe(join(central, "good-skill"));

  for (const bad of ["../secret", "../../etc/passwd", "/etc/passwd", "a/b", "", "..", ".", "x\0y"]) {
    expect(centralSkillDir(bad)).toBeNull();
  }
});

test("读技能文档：越界 id 读不到任何东西", () => {
  expect(getSkillDoc("good-skill")?.markdown).toContain("# Good");
  expect(getSkillDoc("../../secret.txt")).toBeNull();
  expect(getSkillDoc(join(outside, "secret.txt"))).toBeNull();
  expect(getSkillDoc("..")).toBeNull();
});