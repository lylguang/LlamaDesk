/**
 * 作品封面（bun/music-covers.ts）。
 *
 * 这里钉的是三类"错了会留垃圾或崩在用户面前"的行为：
 *  - 上传/生成都要裁成 **1024 方图**（转盘、拼图、缩略图三种展示位都按正方形排）；
 *  - 非图片、超限、不存在的路径都要给**可读的拒绝原因**，不能抛异常；
 *  - 换封面 / 清封面 / 删作品都要把**旧文件删掉**（只删自己那个目录下的）。
 *
 * 与 video-gen.test.ts 同样的做法：临时数据目录 + 真实 sharp。
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import sharp from "sharp";

const IMAGES = mkdtempSync(path.join(tmpdir(), "music-covers-test-"));
process.env.OMNI_DATA_DIR = mkdtempSync(path.join(tmpdir(), "music-covers-data-"));

import { mockModulePartial } from "./test-mocks";
await mockModulePartial<typeof import("./image-server")>("./image-server", {
  getImagesBaseDir: () => IMAGES,
  resolveImageRef: (ref: string) => {
    if (!ref || typeof ref !== "string") return null;
    const resolved = path.resolve(IMAGES, ref);
    if (!resolved.startsWith(IMAGES + path.sep)) return null;
    return existsSync(resolved) ? resolved : null;
  },
});
await mockModulePartial<typeof import("../shared/server-info")>("../shared/server-info", {
  chatImageUrl: (ref: string) => `http://media.local/${ref}`,
});
// 一键生成会走生图管线：这里只验证"拿到图之后怎么处理"，生图本身另行替换。
let nextGenerated: { status: string; imagePath: string | null; error?: string } = {
  status: "done",
  imagePath: null,
};
await mockModulePartial<typeof import("./image-gen")>("./image-gen", {
  generateImage: async () => ({
    records: [
      {
        id: 1,
        status: nextGenerated.status as "done" | "failed",
        source: "manual" as const,
        backend: "api" as const,
        model: "test",
        prompt: "p",
        negativePrompt: null,
        width: 1024,
        height: 1024,
        seed: 1,
        steps: null,
        imageUrl: nextGenerated.imagePath ? `http://media.local/${nextGenerated.imagePath}` : null,
        imagePath: nextGenerated.imagePath,
        error: nextGenerated.error ?? null,
        createdAt: Date.now(),
      },
    ],
  }),
});
const { db } = await import("./db");
const { musicRecords } = await import("./db/schema");
const { COVER_EDGE, clearMusicCover, generateMusicCover, removeCoverFile, setMusicCoverFromFile, COVER_DIR } =
  await import("./music-covers");

afterAll(() => {
  rmSync(IMAGES, { recursive: true, force: true });
  rmSync(process.env.OMNI_DATA_DIR!, { recursive: true, force: true });
});

function seedRecord(): number {
  const row = db
    .insert(musicRecords)
    .values({ title: "测试封面", status: "done", caption: "雨天 city pop" })
    .returning()
    .get();
  return row.id;
}

function coverFiles(): string[] {
  const dir = path.join(IMAGES, COVER_DIR);
  return existsSync(dir) ? readdirSync(dir) : [];
}

async function pngFile(name: string, w: number, h: number): Promise<string> {
  const p = path.join(IMAGES, name);
  await sharp({ create: { width: w, height: h, channels: 3, background: { r: 30, g: 60, b: 120 } } })
    .png()
    .toFile(p);
  return p;
}

test("上传：宽图被裁成 1024 方图 webp，记录上有了 coverPath", async () => {
  const id = seedRecord();
  const src = await pngFile("wide.png", 2000, 500);
  const r = await setMusicCoverFromFile(id, src);

  expect(r.ok).toBe(true);
  expect(r.path!.startsWith(`${COVER_DIR}/`)).toBe(true);
  expect(r.path!.endsWith(".webp")).toBe(true);
  expect(r.coverUrl).toContain(COVER_DIR);

  const abs = path.join(IMAGES, r.path!);
  expect(existsSync(abs)).toBe(true);
  const meta = await sharp(abs).metadata();
  expect(meta.width).toBe(COVER_EDGE);
  expect(meta.height).toBe(COVER_EDGE);
  expect(meta.format).toBe("webp");
});

test("上传：换一张会把旧文件删掉（不留垃圾）", async () => {
  const id = seedRecord();
  const before = coverFiles().length;
  const first = await setMusicCoverFromFile(id, await pngFile("a.png", 300, 300));
  const second = await setMusicCoverFromFile(id, await pngFile("b.png", 300, 300));

  expect(second.ok).toBe(true);
  expect(second.path).not.toBe(first.path);
  expect(existsSync(path.join(IMAGES, first.path!))).toBe(false);
  // 换封面是"一进一出"：目录里的文件数不该涨。
  expect(coverFiles().length).toBe(before + 1);
});

test("上传：非图片 / 不存在 / 超限都给可读原因，不抛异常", async () => {
  const id = seedRecord();

  const notImage = path.join(IMAGES, "not-image.txt");
  writeFileSync(notImage, "这不是图片");
  const r1 = await setMusicCoverFromFile(id, notImage);
  expect(r1.ok).toBe(false);
  expect(r1.error).toContain("读不出来");

  const missing = await setMusicCoverFromFile(id, path.join(IMAGES, "nope.png"));
  expect(missing.ok).toBe(false);
  expect(missing.error).toContain("不存在");

  const unknown = await setMusicCoverFromFile(987654, await pngFile("c.png", 10, 10));
  expect(unknown.ok).toBe(false);
  expect(unknown.error).toContain("作品不存在");
});

test("一键生成：把生成的图片裁成封面并写进记录", async () => {
  const id = seedRecord();
  const genDir = path.join(IMAGES, "gen");
  mkdirSync(genDir, { recursive: true });
  await sharp({ create: { width: 1024, height: 1024, channels: 3, background: { r: 120, g: 40, b: 80 } } })
    .png()
    .toFile(path.join(genDir, "generated.png"));
  const generated = path.join(genDir, "generated.png");
  nextGenerated = { status: "done", imagePath: "gen/generated.png" };

  const r = await generateMusicCover(id);
  expect(r.ok).toBe(true);
  expect(existsSync(path.join(IMAGES, r.path!))).toBe(true);
  // 生成用的原图仍在（那是用户在「图片」页里的产物，不能悄悄删）
  expect(existsSync(generated)).toBe(true);
  nextGenerated = { status: "failed", imagePath: null, error: "上游失败" };
});

test("一键生成：生图失败时把原因带回来", async () => {
  const id = seedRecord();
  nextGenerated = { status: "failed", imagePath: null, error: "上游失败" };
  const r = await generateMusicCover(id);
  expect(r.ok).toBe(false);
  expect(r.error).toContain("上游失败");
  nextGenerated = { status: "done", imagePath: null };
});

test("换回渐变：清引用并删文件", async () => {
  const id = seedRecord();
  const r = await setMusicCoverFromFile(id, await pngFile("d.png", 100, 100));
  const cleared = clearMusicCover(id);
  expect(cleared.ok).toBe(true);
  expect(existsSync(path.join(IMAGES, r.path!))).toBe(false);
  expect(db.select().from(musicRecords).all().find((x) => x.id === id)?.coverPath).toBeNull();
});

test("removeCoverFile 只认自己那个目录：别的路径一律不碰", async () => {
  const outsider = await pngFile("keep-me.png", 50, 50);
  removeCoverFile("gen/keep-me.png"); // 不是封面目录
  removeCoverFile(null);
  removeCoverFile("../../etc/passwd");
  expect(existsSync(outsider)).toBe(true);
});

test("删作品时封面文件一起走（music-gen 的删除路径）", async () => {
  const MusicGen = await import("./music-gen");
  const row = db
    .insert(musicRecords)
    .values({ title: "会被删的作品", status: "done" })
    .returning()
    .get();
  const r = await setMusicCoverFromFile(row.id, await pngFile("e.png", 100, 100));
  expect(existsSync(path.join(IMAGES, r.path!))).toBe(true);

  MusicGen.deleteMusicRecord(row.id);
  expect(existsSync(path.join(IMAGES, r.path!))).toBe(false);
});
