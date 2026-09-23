/**
 * 歌词的纯逻辑：清洗、对齐、LRC 读写、当前行查找。
 *
 * 放在 `shared/` 而不是 `bun/` 或 `mainview/`：**对齐（后端）和高亮（前端）必须用同一套
 * 规则**。一旦各写一份，"哪一行算段落名""时间怎么插值"稍有出入，歌词就会整体错位 ——
 * 而且这种错位只在真播放时才看得出来，测试很难兜住。
 *
 * 本文件不 import 任何进程专属模块（无 db、无 electrobun、无 React）。
 */

/** 一行带时间的歌词。 */
export type TimedLyricLine = { time: number; text: string };

/** ASR 分段（与 bun/asr-parse.ts 的 AsrSegment 同形，这里只取对齐用得到的两项）。 */
export type AlignSegment = { start: number; end: number; text: string };

// ---------------------------------------------------------------------------
// 段落名判定与清洗
// ---------------------------------------------------------------------------

/** 方括号包起来的小标题：`[Verse 1]` / `【主歌一】` / `（前奏）`。 */
const SECTION_BRACKET = /^[[【(（][^\]】)）]*[\]】)）]$/;

/**
 * 这一行是不是"段落名"而不是唱出来的词。
 *
 * 上游返回的歌词常常带 markdown 装饰（实测拿到过 `## 《纸鸢误》`、`**【主歌一】**`），
 * 这些行既不该显示成一屏记号，也不该参与"第几句"的计数 —— 否则高亮整体偏掉。
 */
export function isSectionLine(raw: string): boolean {
  let text = raw.trim();
  if (!text) return true;
  if (/^#{1,6}\s+/.test(text)) return true;
  const bold = stripWholeBold(text);
  if (bold !== text) text = bold;
  return SECTION_BRACKET.test(text);
}

/** 整行被 `**` / `*` 包住时只留里面的内容；行内的强调（半句加粗）不动。 */
export function stripWholeBold(text: string): string {
  const m = /^\*{1,2}([\s\S]+?)\*{1,2}$/.exec(text.trim());
  return m ? m[1]!.trim() : text;
}

/** 去装饰：`## 标题` → `标题`，`**词**` → `词`。 */
export function stripLineDecoration(raw: string): string {
  let text = raw.trim();
  if (/^#{1,6}\s+/.test(text)) text = text.replace(/^#{1,6}\s+/, "").trim();
  return stripWholeBold(text);
}

/** 歌词文本 → 要对齐/高亮的内容行（去空行、去段落名、剥装饰）。 */
export function lyricContentLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !isSectionLine(l))
    .map(stripLineDecoration);
}

// ---------------------------------------------------------------------------
// 文本相似度
// ---------------------------------------------------------------------------

/** 归一化：只留中日韩文字与字母数字，其余（标点、空白、装饰）一律丢掉。 */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}a-z0-9]/gu, "");
}

/** 字符二元组集合：中文短句上比"整串相等"宽容得多，又比单字精确。 */
function bigrams(text: string): Set<string> {
  const set = new Set<string>();
  if (text.length <= 1) {
    if (text) set.add(text);
    return set;
  }
  for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2));
  return set;
}

/** Dice 系数：0~1，越大越像。任一方为空则 0。 */
export function similarity(a: string, b: string): number {
  const x = normalizeForMatch(a);
  const y = normalizeForMatch(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  // 一方包含另一方（ASR 常把一句切成两段、或把两句并成一段）给个高分。
  if (x.includes(y) || y.includes(x)) {
    const ratio = Math.min(x.length, y.length) / Math.max(x.length, y.length);
    return 0.75 + 0.2 * ratio;
  }
  const bx = bigrams(x);
  const by = bigrams(y);
  let hit = 0;
  for (const g of bx) if (by.has(g)) hit += 1;
  return (2 * hit) / (bx.size + by.size);
}

// ---------------------------------------------------------------------------
// 对齐
// ---------------------------------------------------------------------------

/** 对齐阈值：相似度低于它就不认这次匹配（收益记 0，交给 DP 权衡）。 */
export const ALIGN_MIN_SCORE = 0.3;

/**
 * 每行歌词至少占多少秒。隐含速率比它还快的"匹配"是假匹配，要踢掉。
 *
 * 真实录音里最密的唱段（说唱）也在 1 秒/行上下，而**重复副歌**会让 ASR 在错误的段落
 * 上给出高分匹配 —— 实测《纸鸢误》里 15 行被压进 1:49→1:52 这 3 秒，就是这么来的：
 * 第二遍副歌的那句被配到了第一遍的位置，中间整段歌词于是挤成一团。
 */
export const ALIGN_MIN_LINE_SECONDS = 1.2;

/**
 * 把歌词行对齐到 ASR 分段上的时间。
 *
 * **全局最优匹配（DP），不是贪心**。贪心（每行就近找最像的一段）在这种歌词上会明显出错：
 * 相邻两句只差一两个字（`第一句在这里` / `第二句在这里`），贪心会把第二行抢到本该属于
 * 第三行的分段上，第三行就没段可配了 —— 实测把本该 20s 的句子排到了 40s。
 * DP 的收益取 `相似度 - 阈值`（过线的匹配才计正分），于是"牺牲一行、保住更确定的匹配"
 * 会被选出来。
 *
 * 两段式：
 *  1. DP 找最大总收益的"行 ↔ 段"匹配（顺序天然不回头）；
 *  2. 没匹配上的行按前后已知时间**线性插值**，开头 / 结尾按剩余时长摊。
 *
 * 最后强制时间单调不减 —— 高亮是"按时间找当前行"，时间一回头就会出现两句同时亮。
 */
export function alignLinesToSegments(
  lines: string[],
  segments: AlignSegment[],
  totalSeconds: number,
): TimedLyricLine[] {
  const n = lines.length;
  const m = segments.length;
  const times: (number | null)[] = lines.map(() => null);

  /** 匹配收益：低于阈值不给匹配机会，刚过线记 0 分（让更确定的匹配优先）。 */
  const gain = (i: number, j: number): number => {
    const s = similarity(lines[i]!, segments[j]!.text);
    return s >= ALIGN_MIN_SCORE ? s - ALIGN_MIN_SCORE : -1;
  };

  if (n > 0 && m > 0) {
    const width = m + 1;
    const dp = new Float64Array((n + 1) * width);
    const at = (i: number, j: number) => i * width + j;
    for (let i = 1; i <= n; i += 1) {
      for (let j = 1; j <= m; j += 1) {
        let best = Math.max(dp[at(i - 1, j)]!, dp[at(i, j - 1)]!);
        const g = gain(i - 1, j - 1);
        if (g >= 0) best = Math.max(best, dp[at(i - 1, j - 1)]! + g);
        dp[at(i, j)] = best;
      }
    }
    // 回溯出每一行配到了哪一段
    const matched: { line: number; time: number }[] = [];
    let i = n;
    let j = m;
    while (i > 0 && j > 0) {
      const g = gain(i - 1, j - 1);
      if (g >= 0 && Math.abs(dp[at(i, j)]! - (dp[at(i - 1, j - 1)]! + g)) < 1e-9) {
        matched.push({ line: i - 1, time: Math.max(0, segments[j - 1]!.start) });
        i -= 1;
        j -= 1;
      } else if (dp[at(i - 1, j)]! >= dp[at(i, j - 1)]!) {
        i -= 1;
      } else {
        j -= 1;
      }
    }
    matched.reverse();

    // 速率体检：相邻两个锚点之间"每行只有零点几秒"的，是重复段落造成的假匹配 ——
    // 丢掉后一个锚点，中间那些行改由更远的锚点插值，整段才不会挤成一团。
    const anchors: { line: number; time: number }[] = [];
    for (const a of matched) {
      const prev = anchors[anchors.length - 1];
      if (prev && a.time - prev.time < (a.line - prev.line) * ALIGN_MIN_LINE_SECONDS) continue;
      anchors.push(a);
    }
    for (const a of anchors) times[a.line] = a.time;
  }

  const total = Number.isFinite(totalSeconds) && totalSeconds > 0 ? totalSeconds : 0;
  const known = times.map((t, i) => (t == null ? -1 : i)).filter((i) => i >= 0);
  if (known.length === 0) {
    // 一句都没对上（ASR 完全没识别出唱词）：退回均分，至少不会全挤在 0 秒。
    const step = total > 0 ? total / Math.max(1, lines.length) : 0;
    return lines.map((text, i) => ({ time: i * step, text }));
  }

  const first = known[0]!;
  const last = known[known.length - 1]!;
  for (let i = 0; i < lines.length; i += 1) {
    if (times[i] != null) continue;
    if (i < first) {
      times[i] = (times[first]! * i) / Math.max(1, first);
    } else if (i > last) {
      // 结尾：从最后一句摊到总时长（时长未知就按 4 秒一句估）
      const end = total > 0 ? total : times[last]! + (lines.length - last) * 4;
      times[i] = times[last]! + ((end - times[last]!) * (i - last)) / (lines.length - last);
    } else {
      const prev = known.filter((k) => k < i).pop()!;
      const next = known.find((k) => k > i)!;
      times[i] = times[prev]! + ((times[next]! - times[prev]!) * (i - prev)) / (next - prev);
    }
  }

  let running = 0;
  return lines.map((text, i) => {
    const t = Math.max(running, times[i] ?? 0);
    running = t;
    return { time: t, text };
  });
}

// ---------------------------------------------------------------------------
// LRC
// ---------------------------------------------------------------------------

/** 秒 → `[mm:ss.xx]`。 */
export function lrcStamp(seconds: number): string {
  const s = Math.max(0, seconds);
  const mm = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  const cs = Math.min(99, Math.round((s - Math.floor(s)) * 100));
  return `[${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(cs).padStart(2, "0")}]`;
}

/** 时间轴 → LRC 文本（按时间排序）。 */
export function buildLrc(timed: TimedLyricLine[]): string {
  return [...timed]
    .sort((a, b) => a.time - b.time)
    .map((l) => `${lrcStamp(l.time)}${l.text}`)
    .join("\n");
}

/** LRC → 时间轴；没有 `[mm:ss.xx]` 的行丢掉（`[ti:]` 这类元信息行会被过滤）。 */
export function parseLrc(lrc: string): TimedLyricLine[] {
  const out: TimedLyricLine[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const m = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\](.*)$/.exec(raw.trim());
    if (!m) continue;
    const centis = (m[3] ?? "0").padEnd(2, "0").slice(0, 2);
    const time = Number(m[1]) * 60 + Number(m[2]) + Number(centis) / 100;
    const text = m[4]!.trim();
    if (text) out.push({ time: Number.isFinite(time) ? time : 0, text });
  }
  return out.sort((a, b) => a.time - b.time);
}

/** 当前时间落在哪一行（二分）：返回最后一个 `time <= currentTime` 的下标，没有则 -1。 */
export function currentLrcIndex(lines: TimedLyricLine[], currentTime: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid]!.time <= currentTime) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * 没有时间轴时的兜底：把内容行按播放进度均分。
 *
 * 生音乐接口只给整段文本，这是唯一能做的近似 —— 界面必须写明它是估算，
 * 而且用户一键对齐之后就该走 `currentLrcIndex` 那条真时间轴的路。
 */
export function estimatedLineIndex(
  currentTime: number,
  duration: number,
  contentCount: number,
): number {
  if (!(duration > 0) || contentCount <= 0) return -1;
  return Math.min(contentCount - 1, Math.max(0, Math.floor((currentTime / duration) * contentCount)));
}

/** 均分模式下第 `index` 个内容行对应的估算时间（点击歌词跳转用）。 */
export function estimatedLineTime(
  index: number,
  contentCount: number,
  duration: number,
): number | null {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  if (contentCount <= 0 || index < 0 || index >= contentCount) return null;
  return (index / contentCount) * duration;
}
