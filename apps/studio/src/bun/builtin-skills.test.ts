import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// 数据目录由 bunfig 预加载（test-preload.ts）隔离；中央库路径用设置覆盖到临时目录，
// 免得碰到开发者真实的 ~/.agents/skills。
const { updateSettings } = await import("./db/settings");
const { seedBuiltinSkills, listBundledSkillIds, readBuiltinState } = await import("./builtin-skills");
const { hashSkillDir } = await import("./skills/metadata");

const root = mkdtempSync(join(tmpdir(), "builtin-skills-"));
const central = join(root, "central");
const source = join(root, "bundled");

/** 造一个内置技能源目录。 */
function writeSource(id: string, body: string): void {
  const dir = join(source, id);
  mkdirSync(join(dir, "reference"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${id}\ndescription: ${id} 测试技能\n---\n\n${body}\n`);
  writeFileSync(join(dir, "reference", "notes.md"), `参考：${body}\n`);
}

beforeEach(() => {
  rmSync(central, { recursive: true, force: true });
  rmSync(source, { recursive: true, force: true });
  mkdirSync(central, { recursive: true });
  mkdirSync(source, { recursive: true });
  updateSettings({ SKILLS_CENTRAL_PATH: central });
});

afterAll(() => {
  updateSettings({ SKILLS_CENTRAL_PATH: "" });
  rmSync(root, { recursive: true, force: true });
});

describe("内置技能播种", () => {
  test("首次：装进中央库，带上记录", () => {
    writeSource("demo-skill", "v1");
    const report = seedBuiltinSkills({ sourceDir: source });

    expect(report.installed).toEqual(["demo-skill"]);
    expect(existsSync(join(central, "demo-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(central, "demo-skill", "reference", "notes.md"))).toBe(true);

    const state = readBuiltinState();
    expect(state["demo-skill"]?.hash).toBe(hashSkillDir(join(source, "demo-skill")));
    expect(state["demo-skill"]?.deleted).toBeUndefined();
  });

  test("再跑一次是幂等的（不重装、不报错）", () => {
    writeSource("demo-skill", "v1");
    seedBuiltinSkills({ sourceDir: source });
    const before = hashSkillDir(join(central, "demo-skill"));

    const report = seedBuiltinSkills({ sourceDir: source });
    expect(report.installed).toEqual([]);
    expect(report.updated).toEqual([]);
    expect(report.skipped).toEqual(["demo-skill"]);
    expect(hashSkillDir(join(central, "demo-skill"))).toBe(before);
  });

  test("应用升级（源内容变了）且用户没改过 → 自动更新", () => {
    writeSource("demo-skill", "v1");
    seedBuiltinSkills({ sourceDir: source });

    writeSource("demo-skill", "v2");
    const report = seedBuiltinSkills({ sourceDir: source });

    expect(report.updated).toEqual(["demo-skill"]);
    expect(readFileSync(join(central, "demo-skill", "SKILL.md"), "utf8")).toContain("v2");
    expect(readStateHash()).toBe(hashSkillDir(join(source, "demo-skill")));
  });

  test("用户改过副本 → 不覆盖，之后也不再自动更新", () => {
    writeSource("demo-skill", "v1");
    seedBuiltinSkills({ sourceDir: source });

    // 用户改了中央库里的这份
    writeFileSync(join(central, "demo-skill", "SKILL.md"), "用户自己写的\n");
    writeSource("demo-skill", "v2");
    let report = seedBuiltinSkills({ sourceDir: source });
    expect(report.updated).toEqual([]);
    expect(report.skipped).toEqual(["demo-skill"]);
    expect(readFileSync(join(central, "demo-skill", "SKILL.md"), "utf8")).toBe("用户自己写的\n");

    // 再升一版也不动它（避免"这次没改下次就覆盖"的意外）
    writeSource("demo-skill", "v3");
    report = seedBuiltinSkills({ sourceDir: source });
    expect(report.updated).toEqual([]);
    expect(readFileSync(join(central, "demo-skill", "SKILL.md"), "utf8")).toBe("用户自己写的\n");
  });

  test("用户删掉内置技能 → 记墓碑，不复活", () => {
    writeSource("demo-skill", "v1");
    seedBuiltinSkills({ sourceDir: source });

    rmSync(join(central, "demo-skill"), { recursive: true, force: true });
    let report = seedBuiltinSkills({ sourceDir: source });
    expect(report.installed).toEqual([]);
    expect(report.skipped).toEqual(["demo-skill"]);
    expect(existsSync(join(central, "demo-skill"))).toBe(false);
    expect(readBuiltinState()["demo-skill"]?.deleted).toBe(true);

    // 应用升级也不复活
    writeSource("demo-skill", "v2");
    report = seedBuiltinSkills({ sourceDir: source });
    expect(report.installed).toEqual([]);
    expect(existsSync(join(central, "demo-skill"))).toBe(false);
  });

  test("同名技能是用户自己的（没有记录）→ 绝不碰", () => {
    mkdirSync(join(central, "demo-skill"), { recursive: true });
    writeFileSync(join(central, "demo-skill", "SKILL.md"), "用户自己的同名技能\n");
    writeSource("demo-skill", "v1");

    const report = seedBuiltinSkills({ sourceDir: source });
    expect(report.installed).toEqual([]);
    expect(report.skipped).toEqual(["demo-skill"]);
    expect(readFileSync(join(central, "demo-skill", "SKILL.md"), "utf8")).toBe("用户自己的同名技能\n");
  });

  test("删掉记录即可恢复（墓碑不是永久的）", () => {
    writeSource("demo-skill", "v1");
    seedBuiltinSkills({ sourceDir: source });
    rmSync(join(central, "demo-skill"), { recursive: true, force: true });
    seedBuiltinSkills({ sourceDir: source }); // 记墓碑

    rmSync(join(central, ".omnistudio", "builtin.json"), { force: true });
    const report = seedBuiltinSkills({ sourceDir: source });
    expect(report.installed).toEqual(["demo-skill"]);
    expect(existsSync(join(central, "demo-skill", "SKILL.md"))).toBe(true);
  });

  test("没有内置技能时不报错、不建记录", () => {
    const report = seedBuiltinSkills({ sourceDir: join(root, "nope") });
    expect(report).toEqual({ installed: [], updated: [], skipped: [] });
    expect(existsSync(join(central, ".omnistudio", "builtin.json"))).toBe(false);
  });

  test("打包目录里真的有 omni-doctor（忘了配 copy 就会在这里炸）", () => {
    expect(listBundledSkillIds()).toContain("omni-doctor");
  });
});

function readStateHash(): string | undefined {
  const raw = readFileSync(join(central, ".omnistudio", "builtin.json"), "utf8");
  return (JSON.parse(raw) as Record<string, { hash: string }>)["demo-skill"]?.hash;
}
