import { describe, expect, test } from "bun:test";

import { ENGINE_IDS } from "./engines";
import { translate } from "./i18n";
import {
  LOCAL_ENGINE_CATEGORIES,
  LOCAL_ENGINE_CATEGORY_KEYS,
  LOCAL_ENGINE_DIRS,
  LOCAL_ENGINE_SPECS,
  enginesInCategory,
  isInferenceEngineId,
  localEngineSpec,
} from "./local-engines";

/**
 * 引擎目录是界面与主进程的共同真源：id 对不上 → 状态行永远空着；
 * 文案键漏了 → 界面上直接显示 `engines.mflux.role` 这种原文。
 * 这两类问题都不会让编译失败，所以在这里盯住。
 */
describe("本地引擎目录", () => {
  test("id 唯一，文本推理四个引擎与 InferenceEngine 完全对齐", () => {
    const ids = LOCAL_ENGINE_SPECS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    // 推理引擎复用 shared/engines.ts 的 id：多写一个别名，某个 switch 里迟早对不上。
    for (const id of ENGINE_IDS) {
      expect(ids).toContain(id);
      expect(isInferenceEngineId(id)).toBe(true);
    }
    expect(isInferenceEngineId("whisper.cpp")).toBe(false);
    expect(isInferenceEngineId("cloudflared")).toBe(false);
  });

  test("每个分类都有引擎，且每个引擎都归在一个已知分类里", () => {
    for (const category of LOCAL_ENGINE_CATEGORIES) {
      expect(enginesInCategory(category).length).toBeGreaterThan(0);
    }
    const grouped = LOCAL_ENGINE_CATEGORIES.flatMap((c) => enginesInCategory(c));
    expect(grouped.length).toBe(LOCAL_ENGINE_SPECS.length);
  });

  test("托管目录名不重复（两个引擎写进同一个目录 = 卸载会连坐）", () => {
    const dirs = LOCAL_ENGINE_SPECS.map((s) => LOCAL_ENGINE_DIRS[s.id]).filter((d): d is string => !!d);
    expect(new Set(dirs).size).toBe(dirs.length);
  });

  test("未知 id 直接抛错，不返回半个 spec", () => {
    expect(() => localEngineSpec("nope" as never)).toThrow();
  });

  test("每个引擎的说明 / 用途文案在 zh 与 en 都有词条", () => {
    const missing: string[] = [];
    for (const spec of LOCAL_ENGINE_SPECS) {
      for (const key of [spec.roleKey, spec.usedByKey]) {
        for (const lang of ["zh", "en"] as const) {
          if (translate(lang, key) === key) missing.push(`${lang}:${key}`);
        }
      }
    }
    for (const category of LOCAL_ENGINE_CATEGORIES) {
      const keys = LOCAL_ENGINE_CATEGORY_KEYS[category];
      for (const key of [keys.titleKey, keys.descriptionKey]) {
        for (const lang of ["zh", "en"] as const) {
          if (translate(lang, key) === key) missing.push(`${lang}:${key}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
