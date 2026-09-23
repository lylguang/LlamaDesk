/**
 * 已安装模型列表的展示层小工具。
 *
 * 列表里既有"一条 = 一个文件"的条目（GGUF 量化），也有"一条 = 一个仓库"的目录条目
 * （vLLM / SGLang / MLX 的 safetensors 仓库、HF 缓存条目、分批 GGUF 的整组）。
 * 市场页的"这个文件下过没有"要按**文件名**判断，所以必须把目录条目里的成员文件摊平。
 */

import { fileBaseName, safeRepoId } from "../../shared/modelscope";

/** 判"下过没有"只需要这两样：仓库标识 + 它包含的文件名。 */
export type InstalledModelLike = {
  repo: string;
  fileName: string;
  files?: string[] | undefined;
  /** 同目录的非权重文件（config / tokenizer…）：整仓库下载会一起下，判定也要算上。 */
  supportFiles?: string[] | undefined;
};

/**
 * 仓库标识的比对键。
 *
 * 同一个仓库在三处写法不同，必须归一化后才能比：
 *   - 市场里是 repo id（`mlx-community/K2-Horizon-7B-Uno-oQ6e`）；
 *   - 应用下载目录的条目是落盘目录名（`safeRepoId` 编码过的 `mlx-community__K2-Horizon-…`）；
 *   - HF 缓存条目是 `org/repo`（`models--org--repo` 解出来的）。
 * `safeRepoId` 正好把前两者的斜杠差异抹平；大小写再放一档容忍（两个平台都不区分）。
 */
function repoKey(repo: string): string {
  return safeRepoId(repo).toLowerCase();
}

/**
 * 已安装列表 → **指定仓库**在本地已有的文件名集合（权重 + 同目录的配置文件）。
 *
 * 必须按仓库比对：`model-00001-of-00002.safetensors` 这种分片名在几乎每个 safetensors
 * 仓库里都一样，只看文件名会让市场把「别的仓库下过的同名分片」当成这个仓库已经下完 ——
 * 于是「下载整个模型」把这些权重文件整个跳过，落盘只剩 config / tokenizer，模型既跑不了、
 * 也不会出现在本地模型列表里（权重文件不存在，仓库目录压根不算一个模型）。
 *
 * 需要的是"这个文件在这个仓库里下过没有"，跨仓库的同名文件不算数：宁可让用户重下一个
 * 已经有的文件（多花点流量），也不能把没下的权重当成下过（模型直接不可用）。
 *
 * `supportFiles` 一并计入：整仓库下载会把 config / tokenizer 一起下，少了它们
 * 判定就永远差几个文件 —— 下完再看还是「下载整仓库（N 个文件）」。
 */
export function installedFilesForRepo(
  models: readonly InstalledModelLike[],
  repo: string,
): Set<string> {
  const want = repoKey(repo);
  const out = new Set<string>();
  for (const m of models) {
    if (repoKey(m.repo) !== want) continue;
    if (m.files && m.files.length > 0) {
      for (const name of m.files) out.add(fileBaseName(name));
    } else {
      out.add(fileBaseName(m.fileName));
    }
    for (const name of m.supportFiles ?? []) out.add(fileBaseName(name));
  }
  return out;
}
