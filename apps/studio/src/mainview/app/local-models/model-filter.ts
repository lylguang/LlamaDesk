import type { ModelFileKind } from "../../../shared/modelscope";

/**
 * 「选择已下载的模型」下拉的检索 —— 纯函数，界面只负责画。
 *
 * 本机模型动辄几十条（多平台下载 + HF 缓存 + 自己加的目录），按名字扫一遍比拖着滚动条找
 * 快得多。匹配口径：**名字优先、仓库兜底**，多个词是「都要命中」（`qwen 4bit` 能筛出
 * `Qwen3.8-Flash-Next-MLX-Q4` 4bit 那条）。
 */

export type PickerModel = {
  fileName: string;
  repo: string;
  path: string;
  kind: ModelFileKind;
  isActive: boolean;
};

/** 命中位置的分值：名字前缀最优（0），其次名字包含，最后仓库包含。 */
const SCORE_NAME = 1;
const SCORE_REPO = 2;

function scoreModel(model: PickerModel, terms: readonly string[]): number | null {
  const name = model.fileName.toLowerCase();
  const repo = model.repo.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (name.startsWith(term)) continue;
    if (name.includes(term)) {
      score += SCORE_NAME;
      continue;
    }
    if (repo.includes(term)) {
      score += SCORE_REPO;
      continue;
    }
    return null; // 有一个词没命中就不算匹配
  }
  return score;
}

/**
 * 检索 + 排序。
 *
 * 不论有没有搜索词都先排一次序：当前使用的模型置顶（一眼看到"现在跑的是哪个"），
 * 其余按名字自然序（`Qwen3.5` 排在 `Qwen3.10` 前面 —— 数字按数值比，不是字典序）。
 */
export function filterModels<T extends PickerModel>(
  models: readonly T[],
  query: string,
): T[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const scored: { model: T; score: number }[] = [];
  for (const model of models) {
    const score = terms.length === 0 ? 0 : scoreModel(model, terms);
    if (score === null) continue;
    scored.push({ model, score });
  }
  scored.sort(
    (a, b) =>
      Number(b.model.isActive) - Number(a.model.isActive) ||
      a.score - b.score ||
      a.model.fileName.localeCompare(b.model.fileName, undefined, {
        numeric: true,
        sensitivity: "base",
      }),
  );
  return scored.map((s) => s.model);
}
