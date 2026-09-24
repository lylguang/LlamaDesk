import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  INSTALL_MANIFEST_FILE,
  INSTALL_MANIFEST_SCHEMA,
  manifestPath,
  readManifest,
  removeManifest,
  verifyInstall,
  writeManifest,
} from "./install-manifest";

/**
 * manifest 的语义：「存在 = 安装完成过」。安装开始前删掉、全部步骤完成后原子写回，
 * 于是被杀掉的安装验证成 `missing`、坏文件验证成 `corrupt`、换过机器验证成
 * `platform-changed` —— 全部在 tmpdir 里演一遍，不碰真实数据目录。
 */
const decks = new Set<string>();

function tempDir(label: string): string {
  const dir = join(tmpdir(), `omni-install-manifest-${label}-${process.pid}-${decks.size}`);
  decks.add(dir);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterEach(() => {
  for (const dir of decks) rmSync(dir, { recursive: true, force: true });
  decks.clear();
});

const EXPECTED = { engine: "vllm", version: "0.9.2" };

describe("install-manifest", () => {
  test("写 → 读回：字段正确，schema 与 completedAt 由实现自己填", () => {
    const dir = tempDir("roundtrip");
    const before = Date.now();
    expect(writeManifest(dir, { engine: "vllm", version: "0.9.2", platform: process.platform, arch: process.arch, steps: 4 })).toBe(true);
    const after = Date.now();

    const read = readManifest(dir);
    expect(read).not.toBeNull();
    expect(read!.engine).toBe("vllm");
    expect(read!.version).toBe("0.9.2");
    expect(read!.platform).toBe(process.platform);
    expect(read!.arch).toBe(process.arch);
    expect(read!.steps).toBe(4);
    expect(read!.schema).toBe(INSTALL_MANIFEST_SCHEMA);
    expect(read!.completedAt).toBeGreaterThanOrEqual(before);
    expect(read!.completedAt).toBeLessThanOrEqual(after);
  });

  test("没有 manifest → missing", () => {
    const dir = tempDir("missing");
    expect(verifyInstall(dir, EXPECTED)).toEqual({ ok: false, reason: "missing" });
    expect(readManifest(dir)).toBeNull();
  });

  test("非法 JSON → corrupt", () => {
    const dir = tempDir("corrupt");
    writeFileSync(manifestPath(dir), "{ not json", "utf8");
    expect(verifyInstall(dir, EXPECTED)).toEqual({ ok: false, reason: "corrupt" });
  });

  test("schema 对不上 → schema", () => {
    const dir = tempDir("schema");
    writeFileSync(
      manifestPath(dir),
      JSON.stringify({
        schema: 999,
        engine: "vllm",
        completedAt: 1,
        version: "0.9.2",
        platform: process.platform,
        arch: process.arch,
        steps: 1,
      }),
      "utf8",
    );
    expect(verifyInstall(dir, EXPECTED)).toEqual({ ok: false, reason: "schema" });
  });

  test("expected.version 与 manifest 不一致 → version-changed", () => {
    const dir = tempDir("version");
    writeManifest(dir, { engine: "vllm", version: "0.9.1", platform: process.platform, arch: process.arch, steps: 2 });
    expect(verifyInstall(dir, { engine: "vllm", version: "0.9.2" })).toEqual({ ok: false, reason: "version-changed" });
    // 不传 version 时不比较（manifest 版本可能探不到）。
    expect(verifyInstall(dir, { engine: "vllm" })).toEqual({ ok: true, reason: "ok" });
  });

  test("manifest 里 platform 是别的 → platform-changed", () => {
    const dir = tempDir("platform");
    writeManifest(dir, {
      engine: "vllm",
      version: "0.9.2",
      platform: process.platform === "darwin" ? "linux" : "darwin",
      arch: process.arch,
      steps: 2,
    });
    expect(verifyInstall(dir, EXPECTED)).toEqual({ ok: false, reason: "platform-changed" });
  });

  test("removeManifest：不存在 → true；存在 → true 且文件真的没了", () => {
    const dir = tempDir("remove");
    expect(removeManifest(dir)).toBe(true);
    expect(existsSync(manifestPath(dir))).toBe(false);

    writeManifest(dir, { engine: "vllm", version: null, platform: process.platform, arch: process.arch, steps: 1 });
    expect(existsSync(manifestPath(dir))).toBe(true);
    expect(removeManifest(dir)).toBe(true);
    expect(existsSync(manifestPath(dir))).toBe(false);
  });

  test("原子性：写完之后目录里没有残留临时文件", () => {
    const dir = tempDir("atomic");
    writeManifest(dir, { engine: "vllm", version: "0.9.2", platform: process.platform, arch: process.arch, steps: 3 });
    // manifest 文件名本身带点号，`includes` 会误伤；只查临时文件前缀与未预期的文件。
    const unexpected = readdirSync(dir).filter((name) => name !== INSTALL_MANIFEST_FILE);
    expect(unexpected).toEqual([]);
  });

  test("manifest 缺失字段 / 类型不对也当 corrupt（不往外抛）", () => {
    const dir = tempDir("badshape");
    writeFileSync(manifestPath(dir), JSON.stringify({ engine: "vllm" }), "utf8");
    expect(verifyInstall(dir, EXPECTED)).toEqual({ ok: false, reason: "corrupt" });
    writeFileSync(manifestPath(dir), JSON.stringify({ schema: 1, engine: 42 }), "utf8");
    expect(verifyInstall(dir, EXPECTED)).toEqual({ ok: false, reason: "corrupt" });
  });

  test("engine 对不上 → corrupt（文件落在了别的引擎目录里）", () => {
    const dir = tempDir("engine-mismatch");
    writeManifest(dir, { engine: "sglang", version: null, platform: process.platform, arch: process.arch, steps: 1 });
    expect(verifyInstall(dir, EXPECTED)).toEqual({ ok: false, reason: "corrupt" });
    expect(verifyInstall(dir, { engine: "sglang" })).toEqual({ ok: true, reason: "ok" });
  });

  test("writeManifest 会建出还不存在的引擎目录（卸载后重装的路径）", () => {
    const parent = tempDir("fresh");
    const dir = join(parent, "engines", "vllm");
    expect(existsSync(dir)).toBe(false);
    expect(writeManifest(dir, { engine: "vllm", version: "0.9.2", platform: process.platform, arch: process.arch, steps: 1 })).toBe(true);
    expect(existsSync(manifestPath(dir))).toBe(true);
  });
});
