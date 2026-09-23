import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

import { LOCAL_ENGINE_IDS } from "../shared/local-engines";
import { engineInstallSupport } from "../shared/engines";
import { engineDirSize, listLocalEngines, uninstallLocalEngine } from "./engine-catalog";
import { llamaCppBinaryPath, llamaCppRootDir, pythonEnginePython } from "./engine-paths";
import { getDataDir } from "./paths";

/**
 * 引擎管理页的数据来源：状态探测与卸载。
 *
 * 这里盯的是三件真实会出问题的事：
 *  1. 「应用自己装的那份」与「系统里装的那份」必须分开 —— 前者才能卸载，
 *     混了就会出现"卸载按钮点了没反应"或更糟的"把系统那份删了"；
 *  2. 卸载只删托管目录，且报得出释放了多少；
 *  3. 没装过就点卸载要给一句人话，而不是静默成功。
 */

/** 造一份"应用装的" llama.cpp：目录 + 可执行文件 + 版本标记。 */
function fakeLlamaInstall(version = "b10976"): void {
  const dir = llamaCppRootDir();
  mkdirSync(join(dir, "current"), { recursive: true });
  writeFileSync(llamaCppBinaryPath(), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(dir, "current", "VERSION"), `${version}\n`, "utf8");
}

/** 造一份"应用装的" vLLM：venv 里有一个能跑 `import vllm` 的解释器（假的，秒回 0）。 */
function fakeVenvInstall(id: "vllm" | "sglang" | "mlx-lm", version: string): void {
  const python = pythonEnginePython(id);
  mkdirSync(join(python, ".."), { recursive: true });
  writeFileSync(python, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(python, "..", "..", "VERSION"), `${version}\n`, "utf8");
}

const created: string[] = [];

afterEach(() => {
  // 每个用例自己造的目录自己收掉（临时数据目录是共享的）。
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("本地引擎状态", () => {
  test("每个引擎都有状态行（界面按 id 对齐，少一个就是一片空白）", async () => {
    const engines = await listLocalEngines();
    const ids = engines.map((e) => e.id).sort();
    expect(ids).toEqual([...LOCAL_ENGINE_IDS].sort());
    for (const engine of engines) {
      expect(typeof engine.canInstall).toBe("boolean");
      expect(typeof engine.canUninstall).toBe("boolean");
      expect(engine.upgradeKind === "latest" || engine.upgradeKind === "repair").toBe(true);
    }
  });

  test("应用装的 llama.cpp：认得出托管、读得到版本与占用，并且可以卸载", async () => {
    fakeLlamaInstall("b12345");
    created.push(llamaCppRootDir());
    const status = (await listLocalEngines()).find((e) => e.id === "llama.cpp")!;

    expect(status.state).toBe("managed");
    expect(status.version).toBe("b12345");
    expect(status.path).toBe(llamaCppBinaryPath());
    expect(status.managedDir).toBe(llamaCppRootDir());
    expect(status.sizeBytes).toBeGreaterThan(0);
    expect(status.canUninstall).toBe(true);
  });

  test("应用装的 vLLM（venv）：同样认得出托管与版本", async () => {
    fakeVenvInstall("vllm", "0.9.2");
    created.push(join(getDataDir("engines"), "vllm"));
    const status = (await listLocalEngines()).find((e) => e.id === "vllm")!;

    expect(status.state).toBe("managed");
    expect(status.version).toBe("0.9.2");
    expect(status.canUninstall).toBe(true);
  });

  test("系统里能 import vllm 的 python 不算「应用已安装」：无托管 venv = system / missing", async () => {
    // 老实现的 managed 判据是 runtime 的 `mode === "python"`，而 vLLM 的 checkBinary
    // 对系统里那个能 `import vllm` 的 python 也报 mode=python —— 于是装了 vllm 的本机
    // 被显示成"应用已安装"，还给一个会删错目录的卸载按钮。托管判据只看 venv 路径在不在。
    // 测试隔离的数据目录里没有 `<engines>/vllm` 的 venv，而当前进程可能恰好跑在一个
    // 能 import vllm 的 python 上 —— 两种情况都必须落在 non-managed（missing or system），
    // 绝不能是 managed。
    const status = (await listLocalEngines()).find((e) => e.id === "vllm")!;
    expect(status.state).not.toBe("managed");
    expect(status.canUninstall).toBe(false);
    expect(status.managedDir).toBeNull();
  });

  test("Tesseract 由系统包管理器安装：不给卸载入口", async () => {
    const status = (await listLocalEngines()).find((e) => e.id === "tesseract")!;
    expect(status.canUninstall).toBe(false);
    expect(status.managedDir).toBeNull();
  });
});

describe("引擎卸载", () => {
  test("卸载 llama.cpp：删掉托管目录并报出释放的字节数", async () => {
    fakeLlamaInstall();
    const root = llamaCppRootDir();
    expect(existsSync(root)).toBe(true);

    const result = await uninstallLocalEngine("llama.cpp");
    expect(result.ok).toBe(true);
    expect(result.freedBytes).toBeGreaterThan(0);
    expect(existsSync(root)).toBe(false);

    // 再卸一次：没有托管安装了，要给一句人话而不是报成功。
    const again = await uninstallLocalEngine("llama.cpp");
    expect(again.ok).toBe(false);
    expect(again.error).toBeTruthy();
  });

  test("卸载 vLLM：venv 目录整个删掉", async () => {
    fakeVenvInstall("vllm", "0.9.2");
    const dir = join(getDataDir("engines"), "vllm");
    expect(existsSync(dir)).toBe(true);

    const result = await uninstallLocalEngine("vllm");
    expect(result.ok).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  test("系统安装的引擎一律拒绝卸载（应用不接管 PATH 上那份）", async () => {
    const result = await uninstallLocalEngine("tesseract");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("托管");
  });
});

describe("安装前的能力判定", () => {
  test("状态行的 canInstall 必须与 engineInstallSupport 的判定一致", async () => {
    // 界面上的「安装」按钮与主进程真正会做的事只能有一个答案：
    // 两处不一致的结果要么是点下去必然失败，要么是明明能装却只给一句手动提示。
    const engines = await listLocalEngines();
    for (const id of ["llama.cpp", "vllm", "sglang", "mlx"] as const) {
      const status = engines.find((e) => e.id === id)!;
      expect(status.canInstall).toBe(engineInstallSupport(id).supported);
    }
  });

  test("装卸载失败不会把 guard 卡住", async () => {
    // mflux 在测试的临时数据目录里没装过：卸载必须失败，而且不能留下"正在处理"的锁。
    const missing = await uninstallLocalEngine("mflux");
    expect(missing.ok).toBe(false);
    expect(missing.error).toBeTruthy();

    // 紧接着一次合法的卸载仍然进得去 —— guard 卡住的话这里会变成"正在卸载 mflux"。
    fakeLlamaInstall();
    created.push(llamaCppRootDir());
    const result = await uninstallLocalEngine("llama.cpp");
    expect(result.ok).toBe(true);
  });
});

describe("目录占用", () => {
  test("算得出大小；目录不在时是 null", async () => {
    const dir = join(getDataDir("engine-size-test"));
    created.push(dir);
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "a.bin"), Buffer.alloc(4096));
    writeFileSync(join(dir, "sub", "b.bin"), Buffer.alloc(8192));

    const size = await engineDirSize(dir);
    expect(size).toBeGreaterThanOrEqual(12_288);
    expect(await engineDirSize(join(dir, "nope"))).toBeNull();
  });
});
