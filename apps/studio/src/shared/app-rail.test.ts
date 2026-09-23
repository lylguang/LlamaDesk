import { describe, expect, test } from "bun:test";

import {
  APP_RAIL_IDS,
  defaultRailLayout,
  moveRailEntry,
  resolveRailLayout,
  serializeRailLayout,
  toggleRailEntry,
  visibleRailEntries,
} from "./app-rail";

/**
 * 左侧一级菜单布局的解析规则。
 *
 * 这份值存在设置表里，会被手改、会从老版本升上来，所以「解析出什么」比「写入了什么」
 * 更容易出问题：少一条就是菜单里凭空少个应用，多一条就是点了没反应。
 */
describe("一级菜单布局", () => {
  test("空串 / 坏 JSON / 非数组都回落默认：全部条目、全部可见、按默认顺序", () => {
    const expected = APP_RAIL_IDS.map((id) => ({ id, hidden: false }));
    expect(resolveRailLayout("")).toEqual(expected);
    expect(resolveRailLayout(undefined)).toEqual(expected);
    expect(resolveRailLayout(null)).toEqual(expected);
    expect(resolveRailLayout("   ")).toEqual(expected);
    expect(resolveRailLayout("{ 不是 JSON")).toEqual(expected);
    expect(resolveRailLayout('{"id":"chat"}')).toEqual(expected);
    expect(resolveRailLayout('["chat",')).toEqual(expected);
  });

  test("存的顺序就是展示的顺序，隐藏标记跟着走", () => {
    const layout = resolveRailLayout('[{"id":"music"},{"id":"chat","hidden":true}]');
    expect(layout.slice(0, 3)).toEqual([
      { id: "music", hidden: false },
      { id: "chat", hidden: true },
      // 没提到的按默认顺序补在后面
      { id: "agent", hidden: false },
    ]);
    expect(layout).toHaveLength(APP_RAIL_IDS.length);
    expect(visibleRailEntries(layout).map((entry) => entry.id)).not.toContain("chat");
  });

  test("认不出的 id 丢掉、重复的只认第一次 —— 一份坏配置不会把菜单带崩", () => {
    const layout = resolveRailLayout(
      '[{"id":"music"},{"id":"nope"},{"id":"music","hidden":true},{"id":"chat"}]',
    );
    expect(layout.map((entry) => entry.id)).toEqual([
      "music",
      "chat",
      ...APP_RAIL_IDS.filter((id) => id !== "music" && id !== "chat"),
    ]);
    // 第一次出现的 music 没有 hidden 标记 → 保持可见（第二次的 hidden 不该回头改它）
    expect(layout[0]).toEqual({ id: "music", hidden: false });
  });

  test("新增的应用按默认顺序补在末尾且可见（老配置不会把它藏起来）", () => {
    // 模拟：老版本存了一份只有前 14 条的清单，新版本多了 apps
    const older = APP_RAIL_IDS.slice(0, 14).map((id) => ({ id, hidden: false as const }));
    const layout = resolveRailLayout(JSON.stringify(older));
    expect(layout).toHaveLength(APP_RAIL_IDS.length);
    expect(layout[layout.length - 1]).toEqual({ id: "apps", hidden: false });
  });

  test("序列化：默认布局写成空串，非默认写出完整清单（含隐藏项）", () => {
    expect(serializeRailLayout(defaultRailLayout())).toBe("");
    const hidden = toggleRailEntry(defaultRailLayout(), "music");
    expect(serializeRailLayout(hidden)).toBe(
      JSON.stringify(
        APP_RAIL_IDS.map((id) => (id === "music" ? { id, hidden: true } : { id })),
      ),
    );
    // 顺序变过、但没有隐藏项：也要落盘（否则重开应用顺序就回去了）
    const moved = moveRailEntry(defaultRailLayout(), 0, 3);
    expect(serializeRailLayout(moved)).not.toBe("");
    expect(resolveRailLayout(serializeRailLayout(moved)).map((entry) => entry.id)).toEqual(
      moved.map((entry) => entry.id),
    );
  });

  test("移动：最终位置语义（前后两个方向都算对）", () => {
    const ids = (entries: { id: string }[]) => entries.map((entry) => entry.id);
    const base = defaultRailLayout();

    // 往后移：chat 拖到第 3 位
    expect(ids(moveRailEntry(base, 0, 3)).slice(0, 4)).toEqual(["agent", "voicecall", "voice", "chat"]);
    // 往前移：benchmark 拖到第 1 位
    const back = moveRailEntry(base, APP_RAIL_IDS.indexOf("benchmark"), 1);
    expect(ids(back).slice(0, 3)).toEqual(["chat", "benchmark", "agent"]);
    expect(back).toHaveLength(APP_RAIL_IDS.length);
    // 原地不动：返回原数组（引用不变，省一次无意义的重渲染 / 写库）
    expect(moveRailEntry(base, 2, 2)).toBe(base);
    // 越界夹紧：拖到列表外就是首 / 末位
    expect(ids(moveRailEntry(base, 3, 999))[APP_RAIL_IDS.length - 1]).toBe("voice");
    expect(ids(moveRailEntry(base, 3, -5))[0]).toBe("voice");
    // 非法起点不动
    expect(moveRailEntry(base, -1, 2)).toBe(base);
    expect(moveRailEntry(base, 99, 2)).toBe(base);
  });

  test("显示开关：单条显隐不影响别人，且能显式指定", () => {
    const hidden = toggleRailEntry(defaultRailLayout(), "kb");
    expect(hidden.find((entry) => entry.id === "kb")?.hidden).toBe(true);
    expect(hidden.filter((entry) => entry.hidden)).toHaveLength(1);
    const shown = toggleRailEntry(hidden, "kb", false);
    expect(shown.every((entry) => !entry.hidden)).toBe(true);
  });

  test("往返：解析 → 序列化 → 再解析，布局不变（拖动排序落盘后再打开还是那个顺序）", () => {
    const layout = moveRailEntry(toggleRailEntry(defaultRailLayout(), "video"), 0, 5);
    const roundTrip = resolveRailLayout(serializeRailLayout(layout));
    expect(roundTrip).toEqual(layout);
  });
});
