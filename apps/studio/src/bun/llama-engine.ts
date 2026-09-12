/**
 * llama.cpp 引擎（llama-server）的一键安装。
 *
 * 与 whisper-engine 同一套模式：官方 GitHub Release 预编译资产（全部平台均有
 * 官方构建，无需 conda 回退），解压到 userData/engines/llamacpp/current/。
 * 运行时解析顺序：应用内置引擎 → PATH（brew 等）。macOS 资产自带 Metal ggml
 * 后端（libggml-metal.dylib），解压即可用，无额外依赖。
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "fs";
import path from "path";
import { LLAMA_CPP_REPO } from "../shared/llamacpp";
import { getDataDir } from "./paths";

export type LlamaEngineInfo = {
  installed: boolean;
  version: string | null;
  binaryPath: string | null;
  /** 当前平台是否支持一键安装。 */
  supported: boolean;
};

function getEnginesDir(): string {
  return getDataDir("engines", "llamacpp");
}

function getEngineRoot(): string {
  return path.join(getEnginesDir(), "current");
}

function getSearchPath(): string {
  const home = process.env.HOME ?? "";
  const extra = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    home ? `${home}/.local/bin` : "",
    home ? `${home}/bin` : "",
  ];
  const current = process.env.PATH ?? "";
  return [...extra, current].join(":");
}

async function findOnPath(name: string): Promise<string | null> {
  const p = Bun.which(name, { PATH: getSearchPath() });
  return p ?? null;
}

/** 应用内置的 llama-server（userData/engines/llamacpp/current/）。 */
function bundledBinary(name: string): string | null {
  const p = path.join(getEngineRoot(), name);
  return existsSync(p) ? p : null;
}

/** 找到 llama-server：优先应用内置引擎，其次 PATH（brew 等）。 */
export async function resolveLlamaBinary(): Promise<string | null> {
  try {
    const bundled = bundledBinary("llama-server");
    if (bundled) return bundled;
  } catch {}
  return await findOnPath("llama-server");
}

export async function getLlamaEngineInfo(): Promise<LlamaEngineInfo> {
  const server = await resolveLlamaBinary();
  let version: string | null = null;
  try {
    const marker = path.join(getEngineRoot(), "VERSION");
    if (existsSync(marker)) version = (await Bun.file(marker).text()).trim() || null;
  } catch {
    // ignore
  }
  return {
    installed: !!server,
    version,
    binaryPath: server,
    supported: releaseAssetName() !== null,
  };
}

// ---------------------------------------------------------------------------
// 安装收尾
// ---------------------------------------------------------------------------

/** 保证二进制可执行并写入版本标记。 */
async function finalize(engineRoot: string, version: string): Promise<void> {
  const p = path.join(engineRoot, process.platform === "win32" ? "llama-server.exe" : "llama-server");
  if (existsSync(p)) {
    try {
      chmodSync(p, 0o755);
    } catch {
      // Windows 无 POSIX 权限
    }
  }
  try {
    await Bun.write(path.join(engineRoot, "VERSION"), version);
  } catch {
    // ignore
  }
}

function cleanupStaging(staging: string): void {
  rmSync(staging, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// GitHub Release 资产（llama.cpp 官方每个 nightly 都发布全平台预编译包）
// ---------------------------------------------------------------------------

function releaseAssetName(): string | null {
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "llama-{V}-bin-macos-arm64.tar.gz" : "llama-{V}-bin-macos-x64.tar.gz";
  }
  if (process.platform === "linux") {
    if (process.arch === "x64") return "llama-{V}-bin-ubuntu-x64.tar.gz";
    if (process.arch === "arm64") return "llama-{V}-bin-ubuntu-arm64.tar.gz";
    return null;
  }
  if (process.platform === "win32") {
    return process.arch === "x64" ? "llama-{V}-bin-win-cpu-x64.zip" : "llama-{V}-bin-win-cpu-arm64.zip";
  }
  return null;
}

/** 获取官方最新 nightly 的构建编号（形如 b12345），带缓存避免频繁请求。 */
let cachedBuildTag: string | null = null;
async function fetchLatestBuildTag(): Promise<string | null> {
  if (cachedBuildTag) return cachedBuildTag;
  const urls = [
    `https://api.github.com/repos/${LLAMA_CPP_REPO}/releases/latest`,
    "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest",
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) continue;
      const json = (await res.json()) as { tag_name?: string };
      // releases/latest 现在指向只含 nightly-tag.txt 的占位 release（tag 形如 v0.4.0），
      // 真正带二进制的 nightly 用 b12345 形式的 tag,从其资产或nightly标记文件推不出来,
      // 因此优先用 releases 列表里第一个资产名匹配 llama-b*-bin-* 的条目。
      const tag = json.tag_name;
      if (tag && /^b\d+$/.test(tag)) {
        cachedBuildTag = tag;
        return tag;
      }
    } catch {
      // try next
    }
  }
  // releases/latest 的 tag 不带二进制时，遍历最近 release 找带资产的
  try {
    const res = await fetch(`https://api.github.com/repos/${LLAMA_CPP_REPO}/releases?per_page=10`, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const list = (await res.json()) as Array<{ tag_name?: string; assets?: Array<{ name?: string }> }>;
    for (const r of list) {
      const hasBin = (r.assets ?? []).some((a) => a.name?.includes("-bin-"));
      if (hasBin && r.tag_name && /^b\d+$/.test(r.tag_name)) {
        cachedBuildTag = r.tag_name;
        return r.tag_name;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function githubAssetUrls(asset: { tag: string; name: string }): string[] {
  const gh = `https://github.com/${LLAMA_CPP_REPO}/releases/download/${asset.tag}/${asset.name}`;
  // 国内镜像（GitHub 加速），依次回退。
  return [gh, `https://gh-proxy.com/${gh}`, `https://ghfast.top/${gh}`];
}

/** 在解压目录里定位"内容根"（顶层形如 llama-b12345/，内含 llama-server）。 */
function findContentRoot(root: string): string | null {
  const marker = process.platform === "win32" ? "llama-server.exe" : "llama-server";
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      if (entries.some((e) => e.isFile() && e.name === marker)) return dir;
      if (depth < 4) {
        for (const e of entries) {
          if (e.isDirectory()) stack.push({ dir: path.join(dir, e.name), depth: depth + 1 });
        }
      }
    } catch {
      // unreadable entry — skip
    }
  }
  return null;
}

async function installGitHubRelease(
  tmp: string,
  version: string,
): Promise<{ ok: boolean; error?: string }> {
  const engineRoot = getEngineRoot();
  rmSync(engineRoot, { recursive: true, force: true });
  mkdirSync(engineRoot, { recursive: true });

  const staging = path.join(getEnginesDir(), `.staging-${process.pid}`);
  cleanupStaging(staging);
  mkdirSync(staging, { recursive: true });
  try {
    // bsdtar 同时支持 gzip 与 zip；macOS / Windows 10+ 均自带。
    const tar = Bun.spawnSync(["tar", "-xf", tmp, "-C", staging], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (tar.exitCode !== 0) throw new Error(tar.stderr.toString().slice(-200));
  } catch (e) {
    cleanupStaging(staging);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const contentRoot = findContentRoot(staging);
  if (!contentRoot) {
    cleanupStaging(staging);
    return { ok: false, error: "解压后未找到 llama-server" };
  }

  try {
    renameSync(contentRoot, engineRoot);
  } catch (e) {
    cleanupStaging(staging);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  cleanupStaging(staging);
  await finalize(engineRoot, version);
  const marker = process.platform === "win32" ? "llama-server.exe" : "llama-server";
  return bundledBinary(marker) ? { ok: true } : { ok: false, error: "安装后未找到 llama-server" };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 一键安装 llama.cpp 引擎（llama-server）：
 * 全平台走官方 GitHub Release 预编译资产（多镜像回退）；
 * 已安装（应用内置或 PATH 已有）时直接返回成功。
 */
export async function downloadLlamaEngine(): Promise<{ ok: boolean; error?: string; version?: string }> {
  const installed = await resolveLlamaBinary();
  if (installed) {
    return { ok: true, version: (await getLlamaEngineInfo()).version ?? undefined };
  }

  const pattern = releaseAssetName();
  if (!pattern) {
    return {
      ok: false,
      error: `当前平台（${process.platform}/${process.arch}）暂不支持自动安装 llama.cpp，请手动安装 llama-server 并加入 PATH`,
    };
  }

  const tag = await fetchLatestBuildTag();
  if (!tag) {
    return { ok: false, error: "无法获取 llama.cpp 最新构建编号（GitHub 不可达），可改用 brew install llama.cpp" };
  }

  const asset = { tag, name: pattern.replace("{V}", tag) };
  mkdirSync(getEnginesDir(), { recursive: true });
  const tmpName = `.engine-${asset.name}`;
  let lastError = "";
  for (const url of githubAssetUrls(asset)) {
    const tmp = path.join(getEnginesDir(), tmpName);
    try {
      const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(600_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await Bun.write(tmp, res);
      const r = await installGitHubRelease(tmp, tag);
      rmSync(tmp, { force: true });
      if (r.ok) return { ok: true, version: tag };
      throw new Error(r.error ?? "安装失败");
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      rmSync(tmp, { force: true });
      cleanupStaging(path.join(getEnginesDir(), `.staging-${process.pid}`));
    }
  }
  return { ok: false, error: `llama.cpp 引擎安装失败：${lastError}` };
}

/** 删除应用内置的引擎（PATH 上的不受影响）。 */
export function deleteLlamaEngine(): void {
  try {
    rmSync(getEnginesDir(), { recursive: true, force: true });
  } catch {
    // ignore
  }
}
