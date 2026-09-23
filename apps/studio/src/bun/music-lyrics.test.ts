/**
 * 歌词对齐（shared/music-lyrics.ts）。
 *
 * 这些是"错了只会表现为歌词和音乐对不上"的逻辑 —— 界面上看不出 bug，只有真听才发现。
 * 所以把几条硬规则钉住：
 *  - 时间必须单调不减（否则会出现两句同时高亮）；
 *  - 对不上的行要插值，而不是全挤在 0 秒或全丢；
 *  - ASR 一句没认出来时退回均分，而不是把所有人排在第 0 秒；
 *  - LRC 的读写可以往返（写出去再读回来，时间与原行都还在）。
 */
import { expect, test } from "bun:test";

import {
  ALIGN_MIN_LINE_SECONDS,
  ALIGN_MIN_SCORE,
  alignLinesToSegments,
  buildLrc,
  currentLrcIndex,
  estimatedLineIndex,
  estimatedLineTime,
  isSectionLine,
  lyricContentLines,
  normalizeForMatch,
  parseLrc,
  similarity,
} from "../shared/music-lyrics";

/** 造 ASR 分段：[开始秒, 文本]。 */
const seg = (start: number, text: string) => ({ start, end: start + 4, text });

test("相似度：同句最高，包含关系高分，无关句接近 0", () => {
  expect(similarity("宣纸铺开三月的柳烟", "宣纸铺开三月的柳烟")).toBe(1);
  // 标点/空白不影响判断（ASR 不会带标点）。
  expect(similarity("纸鸢断了线，飞向谁的天", "纸鸢断了线飞向谁的天")).toBe(1);
  expect(similarity("纸鸢断了线", "纸鸢断了线飞向谁的天")).toBeGreaterThan(0.75);
  expect(similarity("纸鸢断了线飞向谁的天", "今天天气不错")).toBeLessThan(ALIGN_MIN_SCORE);
  expect(similarity("", "anything")).toBe(0);
});

test("归一化只留文字与字母数字", () => {
  expect(normalizeForMatch("《纸鸢误》 — 2026!")).toBe("纸鸢误2026");
});

test("对齐：能对上的行取 ASR 的时间，对不上的按前后插值且时间单调", () => {
  const lines = ["第一句在这里", "第二句在这里", "第三句在这里"];
  const segments = [seg(12, "第一句在这里"), seg(20, "第三句在这里")];
  const timed = alignLinesToSegments(lines, segments, 60);

  expect(timed.map((t) => t.text)).toEqual(lines);
  expect(timed[0]!.time).toBe(12);
  expect(timed[2]!.time).toBe(20);
  // 中间那句按前后插值：落在 12~20 之间。
  expect(timed[1]!.time).toBeGreaterThan(12);
  expect(timed[1]!.time).toBeLessThan(20);
  // 单调不减是硬要求。
  expect(timed.map((t) => t.time)).toEqual([...timed.map((t) => t.time)].sort((a, b) => a - b));
});

test("对齐：开头没对上的行从 0 摊到第一句，结尾摊到总时长", () => {
  const lines = ["前奏之后的第一句", "中间的句子", "最后一句"];
  const segments = [seg(30, "中间的句子")];
  const timed = alignLinesToSegments(lines, segments, 90);

  expect(timed[1]!.time).toBe(30);
  expect(timed[0]!.time).toBe(0); // 第一句之前只有一行 → 从 0 开始
  expect(timed[2]!.time).toBeGreaterThan(30);
  expect(timed[2]!.time).toBeLessThanOrEqual(90);
});

test("对齐：ASR 一句都没认出来时退回均分，而不是全排在第 0 秒", () => {
  const lines = ["甲", "乙", "丙", "丁"];
  const timed = alignLinesToSegments(lines, [seg(5, "完全无关的内容")], 80);
  expect(timed.map((t) => t.time)).toEqual([0, 20, 40, 60]);
});

test("对齐：歌词行顺序与 ASR 分段顺序一致，不会回头抢前面的段", () => {
  // 副歌重复：同一句歌词出现两次，第二遍必须对到后面那一段，而不是又对上第一段。
  const lines = ["纸鸢断了线", "别的句子", "纸鸢断了线"];
  const segments = [seg(10, "纸鸢断了线"), seg(20, "别的句子"), seg(30, "纸鸢断了线")];
  const timed = alignLinesToSegments(lines, segments, 60);
  expect(timed.map((t) => t.time)).toEqual([10, 20, 30]);
});

test("LRC：写出去再读回来，时间与文本都还在", () => {
  const timed = [
    { time: 0, text: "第一句" },
    { time: 12.5, text: "第二句" },
    { time: 62.25, text: "第三句" },
  ];
  const lrc = buildLrc(timed);
  expect(lrc).toContain("[00:00.00]第一句");
  expect(lrc).toContain("[00:12.50]第二句");
  expect(lrc).toContain("[01:02.25]第三句");
  const back = parseLrc(lrc);
  expect(back.map((l) => l.time)).toEqual([0, 12.5, 62.25]);
  expect(back.map((l) => l.text)).toEqual(["第一句", "第二句", "第三句"]);
});

test("LRC：元信息行与空行被丢掉，乱序会排好", () => {
  const back = parseLrc("[ti:歌名]\n[00:30.00]后一句\n\n[00:10.00]前一句\n不是时间戳的行");
  expect(back.map((l) => l.text)).toEqual(["前一句", "后一句"]);
  expect(back.map((l) => l.time)).toEqual([10, 30]);
});

test("当前行查找：整点、之间、之前、之后都对", () => {
  const lines = parseLrc("[00:10.00]甲\n[00:20.00]乙\n[00:30.00]丙");
  expect(currentLrcIndex(lines, 5)).toBe(-1);
  expect(currentLrcIndex(lines, 10)).toBe(0);
  expect(currentLrcIndex(lines, 19.99)).toBe(0);
  expect(currentLrcIndex(lines, 25)).toBe(1);
  expect(currentLrcIndex(lines, 300)).toBe(2);
  expect(currentLrcIndex([], 10)).toBe(-1);
});

test("均分兜底：时长未知不猜，内容行内按比例", () => {
  expect(estimatedLineIndex(0, 0, 4)).toBe(-1);
  expect(estimatedLineIndex(0, 100, 0)).toBe(-1);
  expect(estimatedLineIndex(0, 100, 4)).toBe(0);
  expect(estimatedLineIndex(50, 100, 4)).toBe(2);
  expect(estimatedLineIndex(99, 100, 4)).toBe(3);
  expect(estimatedLineTime(2, 4, 100)).toBe(50);
  expect(estimatedLineTime(2, 4, 0)).toBeNull();
});

test("段落名判定：方括号 / 井号 / 加粗方括号都算，歌词不算", () => {
  expect(isSectionLine("[Verse 1]")).toBe(true);
  expect(isSectionLine("【主歌一】")).toBe(true);
  expect(isSectionLine("** 【副歌】 **")).toBe(true);
  expect(isSectionLine("## 《纸鸢误》")).toBe(true);
  expect(isSectionLine("")).toBe(true);
  expect(isSectionLine("宣纸铺开三月的柳烟")).toBe(false);
  expect(isSectionLine("**带强调的歌词**")).toBe(false);
});

test("内容行提取：与播放页高亮用的是同一批行", () => {
  const lines = lyricContentLines("## 《纸鸢误》\n**【主歌一】**\n宣纸铺开三月的柳烟\n\n【副歌】\n纸鸢断了线");
  expect(lines).toEqual(["宣纸铺开三月的柳烟", "纸鸢断了线"]);
});


test("对齐：重复段落造成的假锚点被踢掉（否则中间整段会被挤成一团）", () => {
  // 真实踩过的形状：副歌第二遍的那句被配到第一遍的位置，中间 15 行被压进 3 秒。
  const lines = Array.from({ length: 18 }, (_, i) => `第${i + 1}行歌词内容`);
  const segments = [
    { start: 100, end: 104, text: "第1行歌词内容" },
    { start: 103, end: 107, text: "第18行歌词内容" }, // 假匹配：只隔 3 秒
    { start: 190, end: 194, text: "第18行歌词内容" }, // 真的那一遍在后面
  ];
  const timed = alignLinesToSegments(lines, segments, 220);

  expect(timed[0]!.time).toBe(100);
  // 最后一行取真的那一遍，而不是被前面的假锚点抢走。
  expect(timed[17]!.time).toBe(190);
  // 中间每一行都要有"人唱得出来"的间隔，不能被压到零点几秒。
  for (let i = 1; i < timed.length; i += 1) {
    expect(timed[i]!.time - timed[i - 1]!.time).toBeGreaterThanOrEqual(ALIGN_MIN_LINE_SECONDS - 0.001);
  }
});
