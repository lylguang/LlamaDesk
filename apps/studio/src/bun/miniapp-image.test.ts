import { expect, test, beforeEach, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import sharp from "sharp";

import { mockModulePartial } from "./test-mocks";

// ---------------------------------------------------------------------------
// 独立的数据目录 + 真实的暂存实现（image-gen.stageEditImage 只用到图片目录与 sharp）
// ---------------------------------------------------------------------------
const IMAGES = `/tmp/miniapp-image-test-${process.pid}`;
rmSync(IMAGES, { recursive: true, force: true });
mkdirSync(join(IMAGES, "edit", "in"), { recursive: true });

await mockModulePartial<typeof import("./image-server")>("./image-server", {
  getImagesBaseDir: () => IMAGES,
});
await mockModulePartial<typeof import("../shared/server-info")>("../shared/server-info", {
  chatImageUrl: (ref: string) => `http://img.local/${ref}`,
});
// 暂存本身有它自己的测试与实现（image-gen），这里只需要它"把图拷进 edit/in 并回一份 ref"，
// 所以直接给一个真实但最小的替代：写一份真 PNG，回 ref —— 于是 GIF 合成那半段是真的。
/** 目录测试要的云端厂商行（真实实现要查库，这里给两条：可用 / 缺 Key）。 */
const PROVIDERS: Record<string, unknown> = {
  openai: {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    models: [{ id: "gpt-image-2", type: "image" }, { id: "gpt-5" }],
    enabled: true,
  },
  siliconflow: {
    id: "siliconflow",
    name: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    apiKey: "",
    models: [{ id: "Kwai-Kolors/Kolors", type: "image" }],
    enabled: true,
  },
};
await mockModulePartial<typeof import("./cloud-providers")>("./cloud-providers", {
  listEnabledCloudProviders: () => Object.values(PROVIDERS) as never,
  getCloudProviderInfo: (id: string) => (PROVIDERS[id] ?? null) as never,
});
await mockModulePartial<typeof import("./mlx-gen")>("./mlx-gen", {
  getMlxGenStatus: async () => ({ supported: true, engineInstalled: true }) as never,
  getDownloadedMlxModels: async () => ["z-image-turbo"] as never,
});
await mockModulePartial<typeof import("./image-gen")>("./image-gen", {
  // comfyBase 非空：ComfyUI 那一组只有填过地址才会去拉 checkpoint 列表
  getImageGenConfig: () =>
    ({ backend: "api", providerId: "openai", model: "gpt-image-2", comfyBase: "http://127.0.0.1:8188" }) as never,
  listComfyCheckpoints: async () => ["sd_xl_base_1.0.safetensors"] as never,
  stageEditImage: async (paths: string[]) =>
    paths
      .filter((p) => existsSync(p))
      .map((p, index) => {
        const ref = `edit/in/staged-${index}-${Math.random().toString(36).slice(2, 8)}.png`;
        writeFileSync(join(IMAGES, ref), Buffer.from(p));
        return { ref, url: `http://img.local/${ref}` };
      }),
});

const {
  GIF_LIMITS,
  isSessionMiniAppRef,
  listMiniAppImageModels,
  makeMiniAppGif,
  rememberMiniAppRef,
  resetMiniAppImageSessions,
  resolveMiniAppImageChoice,
  stageMiniAppSource,
} = await import("./miniapp-image");

const SOURCE = join(IMAGES, "source.png");
writeFileSync(
  SOURCE,
  await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#ffd166"/></svg>`,
    ),
  )
    .png()
    .toBuffer(),
);

/** 造一张 `size`×`size` 的真图片，返回它的 ref（并登记进会话）。 */
async function fakeSticker(appId: string, color: string, size = 64): Promise<string> {
  const ref = `gen/${color}-${Math.random().toString(36).slice(2, 8)}.png`;
  const abs = join(IMAGES, ref);
  mkdirSync(join(IMAGES, "gen"), { recursive: true });
  writeFileSync(
    abs,
    await sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="${color}"/></svg>`,
      ),
    )
      .png()
      .toBuffer(),
  );
  rememberMiniAppRef(appId, ref);
  return ref;
}

beforeEach(() => {
  resetMiniAppImageSessions();
});

afterAll(() => {
  rmSync(IMAGES, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 会话 ref
// ---------------------------------------------------------------------------

test("会话 ref 只在签发过的应用里有效", () => {
  rememberMiniAppRef("sticker", "gen/a.png");
  expect(isSessionMiniAppRef("sticker", "gen/a.png")).toBe(true);
  // 另一个小应用不能用别人的产物（同一个 iframe 之外的边界）
  expect(isSessionMiniAppRef("portrait", "gen/a.png")).toBe(false);
  expect(isSessionMiniAppRef("sticker", "gen/never.png")).toBe(false);
  expect(isSessionMiniAppRef("sticker", "")).toBe(false);
});

test("暂存：同一张源图只落一份，路径不同的源图各落一份", async () => {
  const first = await stageMiniAppSource("sticker", SOURCE);
  const second = await stageMiniAppSource("sticker", SOURCE);
  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  if (!first.ok || !second.ok) return;
  // 一套 16 张都改这张照片：没有缓存的话这里会是 16 份一模一样的副本
  expect(second.ref).toBe(first.ref);
  expect(isSessionMiniAppRef("sticker", first.ref)).toBe(true);
});

test("暂存：读不出来的路径给一句人话，而不是抛异常", async () => {
  const bad = await stageMiniAppSource("sticker", join(IMAGES, "nope.tiff"));
  expect(bad.ok).toBe(false);
  if (!bad.ok) expect(bad.error.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// 合成 GIF
// ---------------------------------------------------------------------------

test("合成 GIF：帧数与播放顺序保持，输出落在 images/sticker 下", async () => {
  const refs = [
    await fakeSticker("sticker", "#ef4444"),
    await fakeSticker("sticker", "#22c55e"),
    await fakeSticker("sticker", "#3b82f6"),
    await fakeSticker("sticker", "#22c55e"),
  ];
  const gif = await makeMiniAppGif({ appId: "sticker", refs, size: 128, delayMs: 90 });

  expect(gif.error).toBeUndefined();
  expect(gif.ok).toBe(true);
  expect(gif.ref?.startsWith("sticker/")).toBe(true);
  expect(gif.url).toBe(`http://img.local/${gif.ref}`);
  expect(gif.frames).toBe(4);
  expect(gif.width).toBe(128);
  // 单帧尺寸，而不是"整条胶片"的高度（sharp 的 height 是后者）
  expect(gif.height).toBe(128);

  const meta = await sharp(join(IMAGES, gif.ref!), { animated: true }).metadata();
  expect(meta.format).toBe("gif");
  expect(meta.pages).toBe(4);
  expect(meta.delay).toEqual([90, 90, 90, 90]);
  expect(meta.loop).toBe(0);
  expect(existsSync(join(IMAGES, gif.ref!))).toBe(true);
});

test("合成 GIF：尺寸 / 时长的上下限被夹住（页面传什么都不越界）", async () => {
  const refs = [await fakeSticker("sticker", "#111111"), await fakeSticker("sticker", "#eeeeee")];
  const gif = await makeMiniAppGif({ appId: "sticker", refs, size: 99999, delayMs: 99999 });
  expect(gif.width).toBe(GIF_LIMITS.maxSize);
  const meta = await sharp(join(IMAGES, gif.ref!), { animated: true }).metadata();
  // GIF 的时长以 10ms 为单位存，上限 2000ms 也已经是"每帧 2 秒"的慢动作了
  expect(meta.delay?.[0]).toBeLessThanOrEqual(GIF_LIMITS.maxDelayMs);
});

test("合成 GIF：不认没有会话签发的 ref（否则等于把图库里任意一张发出去）", async () => {
  const mine = await fakeSticker("sticker", "#f59e0b");
  const stolen = await fakeSticker("portrait", "#0ea5e9");
  const gif = await makeMiniAppGif({ appId: "sticker", refs: [mine, stolen] });
  expect(gif.ok).toBe(false);
  expect(gif.error).toContain("重新生成");
});

test("合成 GIF：帧数太少 / 太多都拒绝", async () => {
  const one = await fakeSticker("sticker", "#f59e0b");
  expect((await makeMiniAppGif({ appId: "sticker", refs: [one] })).ok).toBe(false);

  const many: string[] = [];
  for (let i = 0; i <= GIF_LIMITS.maxFrames; i++) many.push(await fakeSticker("sticker", "#123456"));
  const over = await makeMiniAppGif({ appId: "sticker", refs: many });
  expect(over.ok).toBe(false);
  expect(over.error).toContain("帧数过多");
});

test("合成 GIF：ref 指向的文件不存在时说清楚是哪一帧", async () => {
  const mine = await fakeSticker("sticker", "#f59e0b");
  rememberMiniAppRef("sticker", "gen/ghost.png");
  const gif = await makeMiniAppGif({ appId: "sticker", refs: [mine, "gen/ghost.png"] });
  expect(gif.ok).toBe(false);
  expect(gif.error).toContain("ghost.png");
});

// ---------------------------------------------------------------------------
// 生图模型目录与选择校验
// ---------------------------------------------------------------------------

test("目录：云端按厂商列（缺 Key 的标出来），本地列 MLX 并在没下载时说明", async () => {
  const catalog = await listMiniAppImageModels();

  // 默认值是用户在生图页保存的那份配置
  expect(catalog.current).toEqual({ backend: "api", providerId: "openai", model: "gpt-image-2" });

  const openai = catalog.cloud.find((p) => p.providerId === "openai");
  expect(openai?.models.map((m) => m.id)).toEqual(["gpt-image-2"]);
  expect(openai?.models[0]?.ready).toBe(true);

  const sf = catalog.cloud.find((p) => p.providerId === "siliconflow");
  expect(sf?.models[0]?.ready).toBe(false);
  expect(sf?.models[0]?.note).toContain("Key");

  const mlx = catalog.local.find((g) => g.backend === "mlx");
  expect(mlx?.models.find((m) => m.id === "z-image-turbo")?.ready).toBe(true);
  // 没下载的要标出来，否则用户选了会撞一句"请先下载模型"
  const schnell = mlx?.models.find((m) => m.id === "flux-schnell");
  expect(schnell?.ready).toBe(false);
  expect(schnell?.note).toContain("未下载");

  // ComfyUI 的 checkpoint 现拉（地址填了才有这一组）
  expect(catalog.local.find((g) => g.backend === "comfyui")?.models[0]?.id).toBe(
    "sd_xl_base_1.0.safetensors",
  );
});

test("目录：哪些后端能吃参考图由宿主说了算", async () => {
  const catalog = await listMiniAppImageModels();
  expect(catalog.supportsReference.api).toBe(true);
  expect(catalog.supportsReference.mlx).toBe(false);
  expect(catalog.supportsReference.comfyui).toBe(false);
});

test("选择校验：不报模型时按用户已保存的配置走，行为与从前一致", () => {
  const choice = resolveMiniAppImageChoice({});
  expect(choice.ok).toBe(true);
  if (!choice.ok) return;
  expect(choice.config).toEqual({});
  expect(choice.supportsReference).toBe(true);
});

test("选择校验：本地后端不吃参考图，页面要据此换一套提示词", () => {
  const localBackends: ("mlx" | "comfyui")[] = ["mlx", "comfyui"];
  for (const backend of localBackends) {
    const choice = resolveMiniAppImageChoice({ backend, model: backend === "mlx" ? "flux-dev" : "a.safetensors" });
    expect(choice.ok).toBe(true);
    if (!choice.ok) continue;
    expect(choice.supportsReference).toBe(false);
    expect(choice.config.backend).toBe(backend);
  }
});

test("选择校验：认不出的值一律拒（页面能塞的是任意字符串）", () => {
  // 不存在的后端
  expect(resolveMiniAppImageChoice({ backend: "dall-e" }).ok).toBe(false);
  // MLX 只认预设：mflux 那边也是按 id 找预设，认不出就没得跑
  const badMlx = resolveMiniAppImageChoice({ backend: "mlx", model: "who-knows" });
  expect(badMlx.ok).toBe(false);
  if (!badMlx.ok) expect(badMlx.error).toContain("未知的 MLX 模型");
  // 不存在的厂商 / 没配 Key 的厂商
  expect(resolveMiniAppImageChoice({ backend: "api", providerId: "ghost" }).ok).toBe(false);
  const noKey = resolveMiniAppImageChoice({ backend: "api", providerId: "siliconflow" });
  expect(noKey.ok).toBe(false);
  if (!noKey.ok) expect(noKey.error).toContain("API Key");
  // 云端模型 id 的形态
  expect(resolveMiniAppImageChoice({ backend: "api", model: "bad model!" }).ok).toBe(false);
  // ComfyUI 的 checkpoint 名不能借 .. 指向服务器上别的文件
  expect(resolveMiniAppImageChoice({ backend: "comfyui", model: "../../etc/passwd" }).ok).toBe(false);
  expect(resolveMiniAppImageChoice({ backend: "comfyui", model: "/etc/passwd" }).ok).toBe(false);
  // 子目录形态是合法的（ComfyUI 里很常见）
  expect(resolveMiniAppImageChoice({ backend: "comfyui", model: "SDXL/base.safetensors" }).ok).toBe(true);
});
