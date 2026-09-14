import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * 前端包不许值导入主进程模块。
 *
 * 起因是一次真实的白屏：通话页为了拿一个模型名常量，从 `bun/realtime-voice.ts`
 * 值导入了 `DEFAULT_REALTIME_MODEL`；而那个模块（经 cloud-providers → db → paths）
 * 在模块级调用 `os.homedir()`。webview 里没有 Node 内置模块，打包后一加载就抛
 * `(0, y7.homedir) is not a function`，整个 React 树没机会挂载 —— 窗口纯白，
 * 而且因为前端 JS 压根没跑起来，连一条 client 错误日志都不会留下。
 *
 * `import type` 不受限（编译后会被抹掉），所以这里按语句形态判断。
 */
const MAINVIEW = join(import.meta.dir, "..", "src", "mainview");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** 语句是不是 `import type ... from "<spec>"` / `import { type X } ...` 这类纯类型导入。 */
function problematicImports(source: string): { spec: string; line: number }[] {
  const found: { spec: string; line: number }[] = [];
  const lines = source.split("\n");
  lines.forEach((line, i) => {
    const m = /^\s*import\s+(.+?)\s+from\s+["']([^"']+)["']/.exec(line);
    if (!m) return;
    const clause = m[1]!;
    const spec = m[2]!;
    // 目标：主进程模块（bun/ 下的相对引用、@/bun/ 别名）。shared/ 两个进程都能用。
    const isBunModule =
      /(^|\/)bun\//.test(spec) || /^@\/bun\//.test(spec) || /^\.\.\/\.\.\/bun\//.test(spec);
    if (!isBunModule) return;
    if (/^type\b/.test(clause)) return; // import type {...}
    // import { type A, type B }：整条都是类型也算安全。
    const braces = /^\{([\s\S]*)\}$/.exec(clause.trim());
    if (braces) {
      const names = braces[1]!.split(",").map((s) => s.trim()).filter(Boolean);
      if (names.length > 0 && names.every((n) => /^type\s/.test(n))) return;
    }
    found.push({ spec, line: i + 1 });
  });
  return found;
}

describe("webview 导入守卫", () => {
  test("mainview 不出现对 bun/* 的值导入（白屏根因）", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(MAINVIEW)) {
      for (const hit of problematicImports(readFileSync(file, "utf8"))) {
        offenders.push(`${relative(MAINVIEW, file)}:${hit.line} ← ${hit.spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("守卫本身认得出值导入、放得过类型导入", () => {
    // 自检：判据一旦写歪（比如漏掉 @/bun/），这条会先失败。
    expect(
      problematicImports(`import { DEFAULT_REALTIME_MODEL } from "../../bun/realtime-voice";`),
    ).toEqual([{ spec: "../../bun/realtime-voice", line: 1 }]);
    expect(problematicImports(`import { UpdateInfo } from "@/bun/updates";`)).toEqual([
      { spec: "@/bun/updates", line: 1 },
    ]);
    expect(problematicImports(`import type { ChatMessage } from "../../bun/chat";`)).toEqual([]);
    expect(problematicImports(`import { type A, type B } from "../../bun/x";`)).toEqual([]);
    expect(problematicImports(`import { type A, B } from "../../bun/x";`)).toEqual([
      { spec: "../../bun/x", line: 1 },
    ]);
    expect(problematicImports(`import { x } from "../../shared/realtime-voice";`)).toEqual([]);
  });
});
