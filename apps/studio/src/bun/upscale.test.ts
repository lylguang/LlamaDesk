/**
 * 超分引擎的纯函数测试。
 *
 * 守的是"跑得通但结果是错的"那类问题：切片网格算错导致拼缝错位、区域提取
 * 坐标错位、浮点输出 → 8 位 RGB 时通道交错、补零偏置与裁剪不一致让图边带上黑边。
 * 它们不会抛异常，只会让放大后的图有拼缝或边缘发毛 —— 所以必须有数值断言。
 */
import { describe, expect, test } from "bun:test";
import {
  extractRegion,
  floatToU8Rgb,
  fromHalf,
  planTileGrid,
  tileCoords,
  toHalf,
  UPSCALE_MODELS,
  DEFAULT_UPSCALE_MODEL,
  upscaleModelSpec,
  blendTiles,
} from "./upscale";

test("模型清单：默认模型存在，且三档各有一个", () => {
  expect(upscaleModelSpec(DEFAULT_UPSCALE_MODEL)).toBeTruthy();
  const tiers = new Set(UPSCALE_MODELS.map((m) => m.tier));
  expect(tiers.has("quality")).toBe(true);
  expect(tiers.has("speed")).toBe(true);
  expect(tiers.has("fast")).toBe(true);
  // 全部都是 4×（当前实现按 scale 固定倍数拼图）
  expect(UPSCALE_MODELS.every((m) => m.scale === 4)).toBe(true);
});

describe("半精度转换", () => {
  test("toHalf：0 与 1 的位模式正确", () => {
    expect(toHalf(0)).toBe(0x0000);
    expect(toHalf(1)).toBe(0x3c00); // fp16 的 1.0
    expect(toHalf(0.5)).toBe(0x3800); // 0.5
    expect(toHalf(-1)).toBe(0xbc00);
  });

  test("fromHalf：位模式解回数值", () => {
    expect(fromHalf(0x0000)).toBe(0);
    expect(fromHalf(0x3c00)).toBe(1);
    expect(fromHalf(0x3800)).toBe(0.5);
    expect(fromHalf(0xbc00)).toBe(-1);
    expect(fromHalf(0x7c00)).toBe(Infinity);
  });

  test("往返：常见像素值经过 fp16 后仍接近原值（误差在半精度范围内）", () => {
    for (const v of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      const round = fromHalf(toHalf(v));
      expect(Math.abs(round - v)).toBeLessThan(0.001);
    }
  });

  test("越界值被压到 Inf / 0，不会跑出 NaN", () => {
    expect(fromHalf(toHalf(1e30))).toBe(Infinity);
    expect(fromHalf(toHalf(1e-30))).toBe(0);
  });
});

describe("切片网格", () => {
  test("小图一个 tile 就够", () => {
    const g = planTileGrid(100, 80, 128, 0);
    expect(g.cols).toBe(1);
    expect(g.rows).toBe(1);
  });

  test("大图按 tile 分成多行多列", () => {
    const g = planTileGrid(400, 128, 128, 0);
    expect(g.cols).toBe(4);
    expect(g.rows).toBe(1);
  });

  test("tileCoords 覆盖整张图且边缘块被钳到图边", () => {
    const g = planTileGrid(300, 200, 128, 0);
    const coords = tileCoords(g, 300, 200);
    // 3 列 × 2 行
    expect(coords.length).toBe(6);
    // 最后一个块（右下）钳到图边
    const last = coords[5]!;
    expect(last.srcW).toBe(300 - 2 * 128); // 44
    expect(last.srcH).toBe(200 - 128); // 72
    // 覆盖范围不越界
    for (const c of coords) {
      expect(c.x + c.srcW).toBeLessThanOrEqual(300);
      expect(c.y + c.srcH).toBeLessThanOrEqual(200);
    }
  });
});

describe("区域提取", () => {
  test("从整图里按坐标切出一块，RGB 顺序不变", () => {
    // 4×3 的图，每个像素 R=G=B=索引
    const width = 4;
    const height = 3;
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i += 1) {
      rgb[i * 3] = i;
      rgb[i * 3 + 1] = i;
      rgb[i * 3 + 2] = i;
    }
    const out = extractRegion(rgb, width, height, 2, 1, 2, 2);
    // 取的是原图 (2,1) 开始 2×2 的块
    expect(out[0]).toBe(6); // 原索引 (y=1,x=2)=6
    expect(out[3]).toBe(7); // (y=1,x=3)=7
    expect(out[6]).toBe(10); // (y=2,x=2)=10
  });
});

describe("floatToU8Rgb", () => {
  test("把 NCHW 浮点输出裁回 srcW×srcH，通道位置正确", () => {
    // 模拟 padSide=4、scale=4、srcW=srcH=2 中央裁回 8×8
    const padSide = 4;
    const scale = 4;
    const ox = 1;
    const oy = 1;
    const outSide = padSide * scale; // 16
    const n = outSide * outSide;
    const data = new Float32Array(n * 3);
    // R 通道全填一种值，G/B 填别的，验证通道没写错位
    for (let i = 0; i < n; i += 1) {
      data[i] = 0.5; // R
      data[n + i] = 0.25; // G
      data[n * 2 + i] = 0.125; // B
    }
    const out = floatToU8Rgb(data, padSide, 2, 2, scale, ox, oy);
    // 输出是 8×8
    expect(out.length).toBe(8 * 8 * 3);
    // 第一个像素：R≈128, G≈64, B≈32
    expect(out[0]).toBe(Math.round(0.5 * 255));
    expect(out[1]).toBe(Math.round(0.25 * 255));
    expect(out[2]).toBe(Math.round(0.125 * 255));
  });
});

describe("拼接", () => {
  test("两块拼回后尺寸与内容正确", () => {
    // 原图 2×2、scale=2，两个横向 tile（每块 1×2 → 放大 2×4）
    const scale = 2;
    const tiles = [
      {
        coord: { x: 0, y: 0, srcW: 1, srcH: 2, outW: 2, outH: 4, col: 0, row: 0 },
        rgb: new Uint8Array([
          255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, // 左列 R
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ]),
      },
      {
        coord: { x: 1, y: 0, srcW: 1, srcH: 2, outW: 2, outH: 4, col: 1, row: 0 },
        rgb: new Uint8Array([
          0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, // 右列 G
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ]),
      },
    ];
    const out = blendTiles(2, 2, scale, tiles);
    expect(out.width).toBe(4);
    expect(out.height).toBe(4);
    // 左上角是左 tile 的 R，右上角是右 tile 的 G
    expect(out.data[0]).toBe(255);
    expect(out.data[1]).toBe(0);
    expect(out.data[2]).toBe(0);
    // 第 0 行第 3 列（列 × 3 通道；行偏移为 0）
    const rightTop = 3 * 3;
    expect(out.data[rightTop]).toBe(0);
    expect(out.data[rightTop + 1]).toBe(255);
  });

  test("重叠区加权平均（不是后贴覆盖）——否则 512 的硬拼缝在照片上很明显", () => {
    // 4×1、scale=1，两个 tile 在 x=2 处重叠：各给 x=2 一个不同的值，结果应是平均。
    const tiles = [
      {
        coord: { x: 0, y: 0, srcW: 3, srcH: 1, outW: 3, outH: 1, col: 0, row: 0 },
        rgb: new Uint8Array([0, 0, 0, 0, 0, 0, 100, 0, 0]),
      },
      {
        coord: { x: 2, y: 0, srcW: 2, srcH: 1, outW: 2, outH: 1, col: 1, row: 0 },
        rgb: new Uint8Array([200, 0, 0, 0, 0, 0]),
      },
    ];
    const out = blendTiles(4, 1, 1, tiles);
    // x=2 处被两块都覆盖：(100 + 200) / 2
    expect(out.data[2 * 3]).toBe(150);
    expect(out.data[0]).toBe(0);
    expect(out.data[3 * 3]).toBe(0);
  });
});
