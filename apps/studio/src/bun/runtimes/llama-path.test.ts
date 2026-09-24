/**
 * llama.cpp 的 `-m` 只收文件：目录条目要换成目录里的主 GGUF。
 *
 * 真实起因：Qwopus3.5-4B-Coder-MTP-GGUF（主模型 + mmproj-F32.gguf）被扫描器聚成
 * 一条目录条目，`-m <snapshot 目录>` 直接 `failed to read magic`，模型永远起不来。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { mainGgufInDir } from "../model-scan";
import { llamaLoadablePath } from "./llama";

function repo(files: Record<string, number>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "gguf-"));
  for (const [name, size] of Object.entries(files)) writeFileSync(path.join(dir, name), Buffer.alloc(size));
  return dir;
}

test("主模型 + mmproj：取主模型，不取投影文件", () => {
  const dir = repo({ "Qwopus3.5-4B-Coder-MTP-Q4_K_M.gguf": 64, "mmproj-F32.gguf": 256 });
  // mmproj 更大也不能选它 —— 它不是能单独加载的模型。
  expect(mainGgufInDir(dir)).toBe(path.join(dir, "Qwopus3.5-4B-Coder-MTP-Q4_K_M.gguf"));
  expect(llamaLoadablePath(dir)).toBe(path.join(dir, "Qwopus3.5-4B-Coder-MTP-Q4_K_M.gguf"));
});

test("分批 GGUF：只认第一片", () => {
  const dir = repo({ "big-00002-of-00003.gguf": 10, "big-00001-of-00003.gguf": 10, "big-00003-of-00003.gguf": 10 });
  expect(mainGgufInDir(dir)).toBe(path.join(dir, "big-00001-of-00003.gguf"));
});

test("同目录多个量化：取最大的那个", () => {
  const dir = repo({ "m-Q4_K_M.gguf": 40, "m-Q8_0.gguf": 80 });
  expect(mainGgufInDir(dir)).toBe(path.join(dir, "m-Q8_0.gguf"));
});

test("文件原样返回；目录里没有可加载的 GGUF 时也原样返回（交给 llama.cpp 报错）", () => {
  const dir = repo({ "m-Q4_K_M.gguf": 8 });
  const file = path.join(dir, "m-Q4_K_M.gguf");
  expect(llamaLoadablePath(file)).toBe(file);
  const onlyProj = repo({ "mmproj-f16.gguf": 8 });
  expect(llamaLoadablePath(onlyProj)).toBe(onlyProj);
  const empty = path.join(tmpdir(), `empty-${Date.now()}`);
  mkdirSync(empty);
  expect(llamaLoadablePath(empty)).toBe(empty);
});
