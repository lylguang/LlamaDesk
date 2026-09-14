import { describe, expect, test } from "bun:test";

import { pickDataDir, type DataDirCandidate } from "./data-dir";

const c = (dir: string, hasSocket: boolean, dbMtime: number): DataDirCandidate => ({ dir, hasSocket, dbMtime });

describe("数据目录选择（omi CLI 找哪个 channel）", () => {
  test("有实例在跑时选它 —— 即使不是最近用过的那个", () => {
    const picked = pickDataDir(
      [c("/d/dev", false, 999), c("/d/canary", true, 100), c("/d/stable", false, 500)],
      "/fallback",
    );
    expect(picked).toBe("/d/canary");
  });

  test("多个实例时选库最新的那个", () => {
    const picked = pickDataDir([c("/d/dev", true, 100), c("/d/canary", true, 800)], "/fallback");
    expect(picked).toBe("/d/canary");
  });

  test("没有实例在跑时选最近用过的 channel（不再永远回落 dev）", () => {
    const picked = pickDataDir([c("/d/dev", false, 100), c("/d/canary", false, 800)], "/fallback");
    expect(picked).toBe("/d/canary");
  });

  test("多个 socket（含上次崩掉留下的残留）→ 仍在写库的那个优先", () => {
    // 崩过的 channel 会留下 socket 文件，但它的库不再变动；正在跑的实例 WAL 一直在写。
    const picked = pickDataDir([c("/d/dev", true, 100), c("/d/canary", true, 900)], "/fallback");
    expect(picked).toBe("/d/canary");
  });

  test("socket 只存在于旧 channel、另一个 channel 库更新 → 仍选有实例的那个", () => {
    // 「有实例在跑」比「最近用过」更值得优先：omi status/logs 要谈的就是它。
    const picked = pickDataDir([c("/d/dev", true, 100), c("/d/canary", false, 900)], "/fallback");
    expect(picked).toBe("/d/dev");
  });

  test("一个候选都没有 → 回退值", () => {
    expect(pickDataDir([], "/fallback")).toBe("/fallback");
    expect(pickDataDir([c("/d/dev", false, 0), c("/d/canary", false, 0)], "/fallback")).toBe("/fallback");
  });

  test("只有一个用过的 channel 就选它", () => {
    expect(pickDataDir([c("/d/dev", false, 0), c("/d/canary", false, 42)], "/fallback")).toBe("/d/canary");
  });
});
