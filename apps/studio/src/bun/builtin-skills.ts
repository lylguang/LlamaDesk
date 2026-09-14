/**
 * 内置技能：随应用打包、首次启动播种到中央技能库。
 *
 * 为什么要有这个：内置技能如果只躺在仓库里，用户装完应用是**看不到**的
 * （Skills 中心读的是中央库 `~/.agents/skills`）。把技能打进包、启动时播种，
 * 用户一装就有，也能像普通技能一样同步给 Claude Code / Cursor 等工具。
 *
 * 播种规则（宁可少做，也不许动用户的东西）：
 *
 * | 中央库里 | 记录里 | 行为 |
 * | --- | --- | --- |
 * | 不存在 | 无记录 | 安装（首次） |
 * | 不存在 | 有记录 | **视为用户删掉了** → 记墓碑，不再复活 |
 * | 存在 | 无记录 | 同名技能是用户自己的 → **不碰** |
 * | 存在 | 有记录，且内容与记录一致 | 内容变了（应用升级）→ 覆盖更新；没变 → 跳过 |
 * | 存在 | 有记录，但内容被改过 | 用户改过 → **不覆盖**（此后也不再自动更新） |
 *
 * 状态记在 `<中央库>/.omnistudio/builtin.json`：`{ "<id>": { hash, at, deleted? } }`。
 * 想恢复一个被删掉的内置技能：删掉对应条目，或直接删掉整个文件，下次启动会重装。
 *
 * 失败一律静默降级（打日志、不影响启动）：内置技能是「有更好」的东西，
 * 不能因为它把 Skills 子系统甚至整个应用搞挂。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

import { logEvent } from "./app-log";
import { copyDirSkipVcs } from "./skills/installer";
import { audit } from "./skills/audit";
import { centralSkillDir, getCentralRepoDir, getMetaDir } from "./skills/central-repo";
import { hashSkillDir, isSkillDir } from "./skills/metadata";

/**
 * 打包进来的内置技能根目录。
 *
 * 路径写法**必须**与 `prompt-library.ts` 一致：`join(import.meta.dir, "<同名目录>")`。
 * 因为打包时整个主进程被合成**一个** `bun/index.js`，所有模块的 `import.meta.dir`
 * 都变成 `bun/`（不再保留源码里的子目录层级）—— 资源放在模块同名目录下，
 * 源码运行与打包运行才会解析到同一个相对位置。放错层级的后果是"静默没有内置技能"。
 */
export const BUILTIN_SKILLS_DIR = join(import.meta.dir, "builtin-skills");

const BUILTIN_STATE_FILE = "builtin.json";

type BuiltinSkillState = {
  /** 上次安装/更新时**内置源**的内容哈希（用于判断安装副本有没有被用户改过）。 */
  hash: string;
  /** 最近一次安装 / 更新时间。 */
  at: number;
  /** 用户删掉了这个内置技能：不再复活。 */
  deleted?: boolean;
};

type BuiltinStateFile = Record<string, BuiltinSkillState>;

export type BuiltinSeedReport = {
  installed: string[];
  updated: string[];
  /** 用户改过 / 同名技能非内置 / 已被用户删除 —— 都算跳过。 */
  skipped: string[];
};

function statePath(): string {
  return join(getMetaDir(), BUILTIN_STATE_FILE);
}

function readState(): BuiltinStateFile {
  try {
    const raw = readFileSync(statePath(), "utf8");
    const parsed = JSON.parse(raw) as BuiltinStateFile;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // 首次运行 / 文件损坏：当作没有记录（后者更安全：不会误判成"用户改过"而永久停更）。
    return {};
  }
}

function writeState(state: BuiltinStateFile): void {
  try {
    const dir = getMetaDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`);
  } catch (e) {
    logEvent({
      level: "warn",
      source: "skills",
      event: "skills.builtin.state_write_failed",
      message: e instanceof Error ? e.message : String(e),
      detail: { path: statePath(), error: e },
    });
  }
}

/** 打包进 bundle 的内置技能 id 列表（目录名即 id）。 */
export function listBundledSkillIds(sourceDir: string = BUILTIN_SKILLS_DIR): string[] {
  try {
    return readdirSync(sourceDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && isSkillDir(join(sourceDir, e.name)))
      .map((e) => e.name)
      .sort();
  } catch (e) {
    // 目录不存在 = 打包漏了 copy，或路径层级算错（见 BUILTIN_SKILLS_DIR 的注释）。
    // **必须留痕**：上一版就是在这里静默返回空数组，装完应用"什么都没有"却查不出原因。
    logEvent({
      level: "warn",
      source: "skills",
      event: "skills.builtin.dir_missing",
      message: `内置技能目录读不到：${sourceDir}`,
      detail: { sourceDir, error: e },
    });
    return [];
  }
}

/**
 * 把内置技能播种进中央库。启动时调用；幂等，重复调用无副作用。
 * 返回本次做了什么（测试与日志用）。
 *
 * `sourceDir` 只给测试用（换成夹具目录），生产路径走打包进来的 `builtin-skills/`。
 */
export function seedBuiltinSkills(options: { sourceDir?: string } = {}): BuiltinSeedReport {
  const sourceDir = options.sourceDir ?? BUILTIN_SKILLS_DIR;
  const report: BuiltinSeedReport = { installed: [], updated: [], skipped: [] };
  let ids: string[];
  try {
    ids = listBundledSkillIds(sourceDir);
  } catch {
    return report;
  }
  if (ids.length === 0) return report;

  let state: BuiltinStateFile;
  try {
    state = readState();
  } catch {
    state = {};
  }
  let dirty = false;

  for (const id of ids) {
    try {
      const source = join(sourceDir, id);
      // id 来自我们自己的目录名，但仍然过一遍中央库的限位校验（单层目录名 + 库内）。
      const target = centralSkillDir(id);
      if (!target) {
        report.skipped.push(id);
        continue;
      }
      const record = state[id];
      const sourceHash = hashSkillDir(source);

      if (record?.deleted) {
        report.skipped.push(id); // 用户删过：不再复活
        continue;
      }

      const installed = existsSync(target);

      if (!installed) {
        if (record) {
          // 装过、现在没了 —— 只能是用户删的。记墓碑，别在下次启动又变回来。
          state[id] = { ...record, deleted: true, at: Date.now() };
          dirty = true;
          report.skipped.push(id);
          continue;
        }
        copyDirSkipVcs(source, target);
        state[id] = { hash: sourceHash, at: Date.now() };
        dirty = true;
        report.installed.push(id);
        continue;
      }

      if (!record) {
        // 同名技能已经在了，且不是我们装的（用户自己建的 / 从市场装的）：不碰。
        report.skipped.push(id);
        continue;
      }

      const installedHash = hashSkillDir(target);
      if (installedHash !== record.hash) {
        // 用户改过这份技能：尊重他的版本，之后也不再自动更新（避免下次直接覆盖掉）。
        report.skipped.push(id);
        continue;
      }
      if (installedHash === sourceHash) {
        report.skipped.push(id); // 已经是最新
        continue;
      }

      rmSync(target, { recursive: true, force: true });
      copyDirSkipVcs(source, target);
      state[id] = { hash: sourceHash, at: Date.now() };
      dirty = true;
      report.updated.push(id);
    } catch (e) {
      // 单个技能失败不牵连其它技能，也不影响启动。
      report.skipped.push(id);
      logEvent({
        level: "warn",
        source: "skills",
        event: "skills.builtin.seed_failed",
        message: e instanceof Error ? e.message : String(e),
        detail: { id, error: e },
      });
    }
  }

  if (dirty) writeState(state);

  if (report.installed.length || report.updated.length) {
    logEvent({
      level: "info",
      source: "skills",
      event: "skills.builtin.seeded",
      message: `内置技能：新装 ${report.installed.length} 个，更新 ${report.updated.length} 个`,
      detail: { installed: report.installed, updated: report.updated, dir: getCentralRepoDir() },
    });
    audit("builtin_seed", [...report.installed, ...report.updated].join(","));
  }

  return report;
}

/** 测试/诊断用：当前记录（含墓碑）。 */
export function readBuiltinState(): BuiltinStateFile {
  return readState();
}
