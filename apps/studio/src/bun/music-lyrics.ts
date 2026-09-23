/**
 * 音乐歌词的两件"一键"：**写词**（没有歌词时用对话模型写一份）与**对齐**（用 ASR 的
 * 分段时间戳把歌词行对上真实时间轴，存成 LRC）。
 *
 * 为什么值得单独一个模块：生音乐接口只返回**整段歌词文本**，没有时间轴。播放页原先按
 * "内容行均分总时长"估着高亮 —— 前奏一长、副歌一重复就全错位。真要同步只有一条路：
 * 把已经生成好的音频转写一遍，拿到每句的时间，再把歌词行对上去。
 *
 * 对齐的可靠性也说清楚：**唱词识别本来就难**（人声叠在伴奏上），ASR 出来的文本往往
 * 只是近似。所以算法是"能对上就用 ASR 的时间，对不上的按前后已知时间插值"，并且
 * 保证时间单调不回头。结果一定比均分强，但不保证逐字精准 —— 界面上也不宣称精准。
 *
 * 纯逻辑全在 `shared/music-lyrics.ts`（前端高亮用的是同一份）；本文件只有两个入口：
 * `generateLyricsForRecord`（写词）与 `alignLyricsForRecord`（对齐），带 IO、要数据库。
 */
import { eq } from "drizzle-orm";
import { generateText } from "ai";

import { db } from "./db";
import { musicRecords } from "./db/schema";
import { logEvent } from "./app-log";
import { getChatModel, getChatModelLabel } from "./chat-model";
import { recordUsage } from "./stats";
import { transcribeAudio, type AsrSegment } from "./asr";
import { alignLinesToSegments, buildLrc, lyricContentLines } from "../shared/music-lyrics";

// 纯逻辑（相似度 / 对齐 / LRC 读写 / 段落名判定）都在 shared/music-lyrics.ts ——
// 前端高亮用的是同一份实现，两边各写一份必然错位。
export { alignLinesToSegments, buildLrc, parseLrc, currentLrcIndex, similarity } from "../shared/music-lyrics";

// ---------------------------------------------------------------------------
// 写词（LLM）
// ---------------------------------------------------------------------------

const LYRICS_SYSTEM = `你是中文作词人。根据用户给出的歌曲信息写一份可以直接演唱的歌词。
要求：
1. 只用【主歌】【副歌】【桥段】这类方括号标段落，每段 4 行左右；
2. 不要 markdown 记号（不要 # 、不要 ** ），不要解释、不要标题、不要前后寒暄；
3. 押韵、口语化、有画面感，与给定的风格一致；
4. 直接输出歌词正文。`;

/** 去掉模型爱加的 ` thinking` 段落与 markdown 记号。 */
function cleanModelOutput(raw: string): string {
  return raw
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>\s*/gi, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*/g, "")
    .trim();
}

/** 一键写词。返回写好的歌词文本（同时落库到 `lyrics`）。 */
export async function generateLyricsForRecord(id: number): Promise<{ lyrics?: string; error?: string }> {
  const row = getRecord(id);
  if (!row) return { error: `作品不存在（id ${id}）` };
  // 翻唱 / 干声配乐的歌词必须与原曲一致，让模型瞎写等于把这首唱成另一首。
  if (row.task === "music_cover" || row.task === "vocal_to_music") {
    return { error: "翻唱与干声配乐的歌词要与原曲一致，不能用模型另写" };
  }
  if (row.instrumental === 1) return { error: "纯器乐作品不需要歌词" };

  const model = getChatModel();
  const prompt = [
    `歌名：${row.title?.trim() || "（未命名，请自定一个）"}`,
    `风格描述：${row.rewrittenCaption?.trim() || row.caption?.trim() || "（无，请自由发挥）"}`,
    `时长参考：${row.durationMs ? `约 ${Math.round(row.durationMs / 1000)} 秒` : "未知"}`,
    "请写歌词：",
  ].join("\n");

  try {
    const result = await generateText({
      model,
      system: LYRICS_SYSTEM,
      prompt,
      temperature: 0.9,
      maxOutputTokens: 1500,
    });
    const text = cleanModelOutput(result.text ?? "");
    if (!text) return { error: "模型没有返回歌词内容" };
    recordUsage(
      getChatModelLabel(),
      result.usage?.inputTokens ?? 0,
      result.usage?.outputTokens ?? 0,
    );
    db.update(musicRecords).set({ lyrics: text }).where(eq(musicRecords.id, id)).run();
    return { lyrics: text };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logEvent({
      level: "error",
      source: "music",
      event: "music.lyrics.generate_failed",
      message,
      detail: { id, error: e },
    });
    return { error: `歌词生成失败：${message}` };
  }
}

// ---------------------------------------------------------------------------
// 对齐（ASR）
// ---------------------------------------------------------------------------

/**
 * 一键对齐：把歌词行对到音频的真实时间轴上，结果存进 `lyric_lrc`。
 *
 * 转写优先用当前配置的 ASR（`source: "auto"`）；如果那个来源不返回分段（有些厂商只
 * 给整段文本），就用本地 whisper 再跑一遍 —— 没有分段就没法对齐，这是硬条件。
 */
export async function alignLyricsForRecord(id: number): Promise<{ lrc?: string; error?: string }> {
  const row = getRecord(id);
  if (!row) return { error: `作品不存在（id ${id}）` };
  if (!row.audioPath) return { error: "这首还没有音频，无法对齐" };

  // 用户填的那份为空时用上游改写后的那份（与播放页显示的一致）。
  const lyricText = row.lyrics?.trim() || row.rewrittenLyrics?.trim() || "";
  const lines = lyricContentLines(lyricText);
  if (lines.length === 0) return { error: "这首没有歌词可以对齐（先写词或补上歌词）" };

  const totalSeconds = (row.durationMs ?? 0) / 1000;
  try {
    let segments: AsrSegment[] = [];
    let engine = "";
    try {
      const t = await transcribeAudio({ audioRef: row.audioPath, save: false, source: "auto", language: "zh" });
      segments = t.segments;
      engine = t.engine;
    } catch (e) {
      // 配置的 ASR 不可用不该直接判死刑：下面还有本地 whisper 这条路。
      logEvent({
        level: "warn",
        source: "music",
        event: "music.lyrics.asr_failed",
        message: e instanceof Error ? e.message : String(e),
        detail: { id, error: e },
      });
    }
    if (segments.length === 0) {
      const t = await transcribeAudio({ audioRef: row.audioPath, save: false, source: "local", language: "zh" });
      segments = t.segments;
      engine = t.engine;
    }
    if (segments.length === 0) {
      return { error: "转写没有返回分段时间戳，无法对齐（换一个 ASR 模型或本地 whisper 再试）" };
    }

    const timed = alignLinesToSegments(lines, segments, totalSeconds);
    const lrc = buildLrc(timed);
    db.update(musicRecords).set({ lyricLrc: lrc }).where(eq(musicRecords.id, id)).run();
    logEvent({
      level: "info",
      source: "music",
      event: "music.lyrics.aligned",
      message: `歌词已对齐：${lines.length} 行 / ${segments.length} 段`,
      detail: { id, engine, lines: lines.length, segments: segments.length },
    });
    return { lrc };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logEvent({
      level: "error",
      source: "music",
      event: "music.lyrics.align_failed",
      message,
      detail: { id, error: e },
    });
    return { error: `对齐失败：${message}` };
  }
}

function getRecord(id: number) {
  if (!Number.isInteger(id) || id <= 0) return undefined;
  return db.select().from(musicRecords).where(eq(musicRecords.id, id)).limit(1).all()[0];
}
