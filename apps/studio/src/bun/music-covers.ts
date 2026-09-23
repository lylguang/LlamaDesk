/**
 * 作品封面：`一键生成`（复用生图管线）、`本地上传`、`换回渐变`。
 *
 * 为什么封面要落成一张**真图片**：之前封面是按歌名算出来的渐变（`cover.tsx`）——
 * 好看、零成本，但它不表达任何东西，歌单一多就分不清谁是谁。作品图这件事，用户自己
 * 挑一张、或者让模型画一张，才是他要的。
 *
 * 三条约定：
 *  1. **一律方图**：播放页的转盘、歌单的 2×2 拼图、列表缩略图都按正方形排布，
 *     非方图进去会被裁得莫名其妙。所以入库前统一 `fit: cover` 裁成 1024×1024 的 webp
 *     （好看、体积小、sharp 出图稳定）。
 *  2. **换封面要删旧文件**：只改库里的引用会让 `images/music/covers/` 变成只增不减的垃圾场。
 *  3. **删作品时封面一起走**（`music-gen.deleteMusicRecord` 调 `removeCoverFile`）。
 *
 * 生成的封面会**同时留在生图记录里**：那是一次真实的生成，用户可能在图片页还想用它 ——
 * 我们不做"悄悄删掉用户产物"这种事。
 */
import { existsSync, mkdirSync, statSync, unlinkSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import sharp from "sharp";

import { db } from "./db";
import { musicRecords } from "./db/schema";
import { getImagesBaseDir, resolveImageRef } from "./image-server";
import { chatImageUrl } from "../shared/server-info";
import { logEvent } from "./app-log";
import { generateImage } from "./image-gen";

/** 封面在 images 根目录下的子目录。 */
export const COVER_DIR = "music/covers";
/** 封面边长：1024 对"转盘 + 拼图 + 缩略图"三种用途都够，webp 下通常一百多 KB。 */
export const COVER_EDGE = 1024;
/** 上传原图大小上限：20MB（手机直出的照片也在这个量级内）。 */
export const COVER_MAX_BYTES = 20 * 1024 * 1024;

export type CoverResult = { ok: boolean; coverUrl?: string; path?: string; error?: string };

function coverDirAbs(): string {
  const dir = path.join(getImagesBaseDir(), COVER_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 把任意一张图变成封面文件：EXIF 摆正 → 方图裁剪 → 1024 → webp。
 *
 * `fit: "cover"` 会居中裁剪，宽高不同的图不会变形 —— 封面这种展示位，宁可裁掉边缘。
 */
async function writeCoverFile(input: string | Buffer): Promise<{ ref: string; url: string }> {
  const dir = coverDirAbs();
  const name = `${randomUUID()}.webp`;
  const dest = path.join(dir, name);
  await sharp(input, { failOn: "none" })
    .rotate()
    .resize(COVER_EDGE, COVER_EDGE, { fit: "cover", position: "attention" })
    .webp({ quality: 88 })
    .toFile(dest);
  const ref = `${COVER_DIR}/${name}`;
  return { ref, url: chatImageUrl(ref) };
}

/** 删掉封面文件（只认自己那个目录下的路径，别的什么都不碰）。 */
export function removeCoverFile(ref: string | null | undefined): void {
  if (!ref) return;
  if (!ref.startsWith(`${COVER_DIR}/`)) return;
  const abs = resolveImageRef(ref);
  if (!abs) return;
  try {
    unlinkSync(abs);
  } catch {
    /* 已经被删掉了：不是错误 */
  }
}

/** 从本地上传：`filePath` 来自刚弹过的文件选择框（与 stageAudio 同一套信任模型）。 */
export async function setMusicCoverFromFile(id: number, filePath: string): Promise<CoverResult> {
  const row = getRecord(id);
  if (!row) return { ok: false, error: `作品不存在（id ${id}）` };
  if (!filePath || !existsSync(filePath)) return { ok: false, error: "文件不存在" };
  try {
    if (!statSync(filePath).isFile()) return { ok: false, error: "选中的不是文件" };
  } catch {
    return { ok: false, error: "读不到这个文件" };
  }
  const size = statSync(filePath).size;
  if (size > COVER_MAX_BYTES) {
    return { ok: false, error: `图片太大（${Math.round(size / 1024 / 1024)}MB，上限 20MB）` };
  }

  let cover: { ref: string; url: string };
  try {
    cover = await writeCoverFile(filePath);
  } catch (e) {
    // sharp 解不开 = 不是图片（或被截断）。这里必须给可读的原因，不能只说"失败"。
    const message = e instanceof Error ? e.message : String(e);
    logEvent({
      level: "warn",
      source: "music",
      event: "music.cover.decode_failed",
      message,
      detail: { id, error: e },
    });
    return { ok: false, error: `这张图读不出来（支持 png / jpg / webp / gif / bmp）` };
  }
  return applyCover(id, row.coverPath, cover);
}

/** 把新封面写进记录，并删掉被替换掉的旧文件。 */
function applyCover(
  id: number,
  previous: string | null | undefined,
  cover: { ref: string; url: string },
): CoverResult {
  db.update(musicRecords).set({ coverPath: cover.ref }).where(eq(musicRecords.id, id)).run();
  removeCoverFile(previous);
  logEvent({
    level: "info",
    source: "music",
    event: "music.cover.updated",
    message: `作品 ${id} 的封面已更新`,
    detail: { id, ref: cover.ref },
  });
  return { ok: true, coverUrl: cover.url, path: cover.ref };
}

/**
 * 一键生成封面：用生图管线画一张方图，再裁成封面。
 *
 * 提示词按"专辑封面"的套路拼：歌名 + 风格描述 + 明确的否定项（不要文字 —— 图上出现
 * 乱码文字是 AI 封面最出戏的地方）。
 */
export async function generateMusicCover(id: number, promptOverride?: string): Promise<CoverResult> {
  const row = getRecord(id);
  if (!row) return { ok: false, error: `作品不存在（id ${id}）` };

  const title = row.title?.trim();
  const style = row.rewrittenCaption?.trim() || row.caption?.trim() || "";
  const prompt =
    promptOverride?.trim() ||
    [
      "一张音乐专辑封面插画，正方形构图",
      title ? `主题：${title}` : "",
      style ? `风格与氛围：${style}` : "",
      "画面完整、留白克制、高级质感、柔和光影",
    ]
      .filter(Boolean)
      .join("。")
      .concat("。不要出现任何文字、字母、水印、logo。");

  const result = await generateImage({
    prompt,
    negativePrompt: "文字, 字母, 汉字, 水印, logo, 签名, 低质量, 变形",
    width: COVER_EDGE,
    height: COVER_EDGE,
    count: 1,
    source: "manual",
  });
  if (result.error || result.records.length === 0) {
    return { ok: false, error: result.error ?? "生图没有返回结果" };
  }
  const generated = result.records[0]!;
  if (generated.status !== "done" || !generated.imagePath) {
    return { ok: false, error: generated.error ?? "生图没有产出图片" };
  }
  const abs = resolveImageRef(generated.imagePath);
  if (!abs) return { ok: false, error: "生成的图片不在数据目录里" };

  let cover: { ref: string; url: string };
  try {
    cover = await writeCoverFile(abs);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logEvent({
      level: "error",
      source: "music",
      event: "music.cover.write_failed",
      message,
      detail: { id, error: e },
    });
    return { ok: false, error: "生成的图片处理失败" };
  }
  return applyCover(id, row.coverPath, cover);
}

/** 换回渐变封面（删文件 + 清引用）。 */
export function clearMusicCover(id: number): CoverResult {
  const row = getRecord(id);
  if (!row) return { ok: false, error: `作品不存在（id ${id}）` };
  db.update(musicRecords).set({ coverPath: null }).where(eq(musicRecords.id, id)).run();
  removeCoverFile(row.coverPath);
  return { ok: true };
}

function getRecord(id: number) {
  if (!Number.isInteger(id) || id <= 0) return undefined;
  return db.select().from(musicRecords).where(eq(musicRecords.id, id)).limit(1).all()[0];
}
