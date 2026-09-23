/**
 * 播放页歌词的**展示**逻辑：把一段歌词变成"要显示的行"。
 *
 * 纯逻辑（段落名判定、装饰剥离、LRC 读写、当前行查找、估算兜底）都在
 * `shared/music-lyrics.ts` —— 后端对齐与前端高亮必须用同一套规则，各写一份必然错位。
 * 这里只补展示层要的那点加工（把"清洗后的文本 + 是否段落标题"合成一行）。
 *
 * 单独成模块的另一个原因：它被单曲播放页与创作结果卡两处共用，留在播放页里会让
 * 结果卡反向 import 播放页，绕成一个循环。
 */
import { isSectionLine, stripLineDecoration } from "../../../shared/music-lyrics";

export {
  buildLrc,
  currentLrcIndex,
  estimatedLineIndex,
  estimatedLineTime,
  isSectionLine,
  parseLrc,
  type TimedLyricLine,
} from "../../../shared/music-lyrics";

/** 一行歌词：`text` 是清洗后要显示的内容，`tag` 表示它是段落标题而不是唱出来的词。 */
export type LyricLine = { text: string; tag: boolean };

/** 解析一行：剥掉 markdown 装饰，并判定它是不是段落标题。 */
export function parseLyricLine(raw: string): LyricLine {
  const text = stripLineDecoration(raw);
  if (text.length === 0) return { text: "", tag: false };
  return { text, tag: isSectionLine(raw) };
}

/** 整段歌词 → 逐行（去空行、剥装饰、标出段落标题）。 */
export function parseLyrics(raw: string): LyricLine[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseLyricLine);
}
