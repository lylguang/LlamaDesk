/**
 * 内置技能一致性：`src/bun/builtin-skills/`（随应用打包的规范副本）与仓库根的
 * `.agents/skills/` 镜像（给在本仓库里干活的编码 Agent 用）必须逐字节一致。
 *
 * 跑法：
 *   bun run scripts/builtin-skills-smoke.ts            校验（不一致就报错）
 *   bun run scripts/builtin-skills-smoke.ts --write    用内置副本覆盖镜像
 *
 * 为什么要有镜像：内置副本在 `apps/studio/src/bun/builtin-skills/`，那是应用包内部
 * 的路径；在本仓库里工作的 Claude Code / Codex / ZCode 扫的是 `.agents/skills/`。
 * 两份内容必须一致，否则「Agent 按技能文档排查出来的结论」和「应用里播出去的技能」
 * 会慢慢分叉 —— 这正是 cli-docs / docs/omi-cli.md 用同一套校验防的问题。
 *
 * 另外校验**打包约定**：内置技能目录必须与同名的 `builtin-skills.ts` 平级，
 * 因为打包后主进程被合成单个 `bun/index.js`，只有"模块名 = 同级资源目录名"
 * 这种布局才能让 dev 与打包两条路径解析到同一个位置（见 builtin-skills.ts 注释）。
 * 放错层级不会报错，只会"静默没有内置技能"—— 所以要在这里挡住。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "fs";
import { readFileSync } from "fs";
import path from "path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const builtinDir = path.join(repoRoot, "apps", "studio", "src", "bun", "builtin-skills");
const builtinModule = path.join(repoRoot, "apps", "studio", "src", "bun", "builtin-skills.ts");
const mirrorRoot = path.join(repoRoot, ".agents", "skills");
const write = process.argv.includes("--write");

let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

/** 收集相对路径 → 内容（只比内容与结构，不比时间戳）。 */
function snapshot(root: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name === ".DS_Store" || entry.name === ".git") continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) out.set(rel, readFileSync(full));
    }
  };
  if (existsSync(root) && statSync(root).isDirectory()) walk(root, "");
  return out;
}

if (!existsSync(builtinDir)) {
  console.log("没有内置技能目录，跳过。");
  process.exit(0);
}

console.log("打包约定");
check(
  "内置技能目录与同名模块平级（builtin-skills.ts + builtin-skills/）",
  existsSync(builtinModule),
  existsSync(builtinModule) ? undefined : "缺少 src/bun/builtin-skills.ts —— 打包后 import.meta.dir 会算错位置",
);
{
  // 打包后的解析结果必须与 copy 目标一致：bun/builtin-skills
  const configPath = path.join(repoRoot, "apps", "studio", "electrobun.config.ts");
  const config = readFileSync(configPath, "utf8");
  check(
    "electrobun.config.ts 把它复制到 bun/builtin-skills",
    /"src\/bun\/builtin-skills":\s*"bun\/builtin-skills"/.test(config),
  );
}

const ids = readdirSync(builtinDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

check("内置技能目录非空", ids.length > 0, ids.join(", ") || "空");

console.log("\n内置副本 ↔ 仓库镜像");
for (const id of ids) {
  const source = path.join(builtinDir, id);
  const mirror = path.join(mirrorRoot, id);

  if (write) {
    rmSync(mirror, { recursive: true, force: true });
    mkdirSync(path.dirname(mirror), { recursive: true });
    cpSync(source, mirror, { recursive: true });
    check(`${id}：已同步到 .agents/skills/`, true);
    continue;
  }

  const a = snapshot(source);
  const b = snapshot(mirror);
  const missing = [...a.keys()].filter((k) => !b.has(k));
  const extra = [...b.keys()].filter((k) => !a.has(k));
  const changed = [...a.keys()].filter((k) => b.has(k) && !a.get(k)!.equals(b.get(k)!));

  const detail = [
    missing.length ? `镜像缺 ${missing.join(", ")}` : "",
    extra.length ? `镜像多 ${extra.join(", ")}` : "",
    changed.length ? `内容不一致 ${changed.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("；");

  check(
    `${id}：${a.size} 个文件与镜像一致`,
    detail === "",
    detail || undefined,
  );
}

if (write) {
  console.log("\n已用内置副本覆盖 .agents/skills 镜像。");
} else if (failed > 0) {
  console.log("\n运行 bun run scripts/builtin-skills-smoke.ts --write 同步镜像。");
}

console.log(failed === 0 ? "\n全部通过。" : `\n${failed} 项未通过。`);
process.exit(failed === 0 ? 0 : 1);
