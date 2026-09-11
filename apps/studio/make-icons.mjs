/**
 * 从用户提供的源 logo 生成 LlamaDesk 全套品牌图标:
 *   - apps/studio/icon.iconset/(macOS 全 10 尺寸,electrobun 直接消费)
 *   - apps/studio/icon-linux.png(512)
 *   - apps/studio/icon.ico(256,PNG 容器封装)
 *   - 根 logo.png 与 .github/assets/logo.png(README 展示用,圆角)
 *
 * 用法:node make-icons.js <源图2048.png> <项目根目录>
 * 依赖 sharp:在 /tmp/omni-studio-analysis/apps/studio 下运行(那边装了依赖)。
 */
import sharp from "sharp";
import { join } from "path";
import { writeFileSync } from "fs";

const [src, root] = process.argv.slice(2);
const studio = join(root, "apps", "studio");

// ── 裁剪:聚焦胡萝卜主体,避开右下角"豆包AI生成"水印(y≈1900 以下) ──
const CROP = { left: 240, top: 120, size: 1600 };

// ── macOS 图标主模版:1024 画布,磁贴占 86%,圆角 22.4%(Apple squircle 近似) ──
async function roundedTile(canvasSize, tileSize, radiusPct) {
  const tilePx = Math.round((canvasSize * tileSize) / 100);
  const radius = Math.round((tilePx * radiusPct) / 100);
  const offset = Math.round((canvasSize - tilePx) / 2);
  const mask = Buffer.from(
    `<svg width="${tilePx}" height="${tilePx}">
       <rect x="0" y="0" width="${tilePx}" height="${tilePx}" rx="${radius}" ry="${radius}"/>
     </svg>`
  );
  return sharp(src)
    .extract({ left: CROP.left, top: CROP.top, width: CROP.size, height: CROP.size })
    .resize(tilePx, tilePx)
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
}

async function writeIconMaster(master, outPath, size) {
  await sharp(master).resize(size, size).png().toFile(outPath);
}

// ── ICO 封装:直接把 PNG 嵌进 ICO 容器(Vista+ 支持 PNG 帧) ──
function pngToIco(pngBuf, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size >= 256 ? 0 : size, 0); // width
  entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
  entry.writeUInt8(0, 2); // palette
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(pngBuf.length, 8); // data size
  entry.writeUInt32LE(22, 12); // data offset
  return Buffer.concat([header, entry, pngBuf]);
}

const master = await roundedTile(1024, 86, 22.4);
const iconset = {
  "icon_16x16.png": 16,
  "icon_16x16@2x.png": 32,
  "icon_32x32.png": 32,
  "icon_32x32@2x.png": 64,
  "icon_128x128.png": 128,
  "icon_128x128@2x.png": 256,
  "icon_256x256.png": 256,
  "icon_256x256@2x.png": 512,
  "icon_512x512.png": 512,
  "icon_512x512@2x.png": 1024,
};
for (const [name, size] of Object.entries(iconset)) {
  await writeIconMaster(master, join(studio, "icon.iconset", name), size);
}
console.log("iconset ✓");

// Linux PNG(无圆角要求,但保持一致风格)
await sharp(master).resize(512, 512).png().toFile(join(studio, "icon-linux.png"));
console.log("icon-linux.png ✓");

// Windows ICO(256)
const icoPng = await sharp(master).resize(256, 256).png().toBuffer();
writeFileSync(join(studio, "icon.ico"), pngToIco(icoPng, 256));
console.log("icon.ico ✓");

// README 展示 logo(圆角更满一点:磁贴 94%,圆角 20%)
const readmeMaster = await roundedTile(1024, 94, 20);
for (const p of [join(root, "logo.png"), join(root, ".github", "assets", "logo.png")]) {
  await sharp(readmeMaster).resize(512, 512).png().toFile(p);
}
console.log("README logo ✓");
