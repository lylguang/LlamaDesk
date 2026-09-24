import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";

import { buildLaunchPlanKeyFromSettings, __setLaunchPlanForTest } from "../launch-plan";
import { mockModulePartial } from "../test-mocks";
import { llamaCppBinaryPath } from "../engine-paths";
import { effectiveFlashAttnForPlan } from "./llama";
import { DEFAULT_CUSTOM_SERVER_ARGS } from "./llama";
import type { LaunchPlan } from "../../shared/launch-planner";

/**
 * llama.cpp 运行时的命令行构造：purpose=embedding 两态快照（③-A1a）。
 *
 * 桩掉设置表 / 模型扫描 / 模型库，只测 buildArgs / buildCommandLine 自己：
 *   1. chat 实例命令行与旧版逐字节一致（聊天路径零变化）；
 *   2. embedding 实例追加 `--embeddings --pooling`、裁剪聊天采样参数、端口回落嵌入段。
 */

// 桩一律「读写同源」并尽量展开真实模块：bun 的 mock.module 是进程级共享、
// 且 ESM 绑定在首次导入时固化——getSetting 覆盖而 updateSettings 留真实（写临时
// DB）会让之后评估的 central-repo.test.ts 出现「写入丢失」假失败（读写分家）。
// 形态对齐 model-servers.test.ts 那份在全量跑里验证过的桩：同一本地 store 读写。
// 展开真实模块再覆盖（mock-hygiene.test.ts 规矩）：db/settings 新增导出后字面量替身会炸。
const SETTINGS: Record<string, string> = {};
let PORT_OVERRIDE: string | null = null;
const realSettings = await import("../db/settings");
mock.module("../db/settings", () => ({
  ...realSettings,
  // 与真 getSetting 同一读路径：未设过（undefined）回落 DEFAULTS，显式空串保持空
  // （真 DB 里 "" 就是空，不会回落默认）。GPU 层的 -1 哨兵依赖这个默认值。
  getSetting: (key: string) => {
    if (key in SETTINGS) return SETTINGS[key];
    return (realSettings as { DEFAULTS?: Record<string, string> }).DEFAULTS?.[key] ?? "";
  },
  getNumericSetting: (key: string) => Number(SETTINGS[key] ?? 0) || 0,
  updateSettings: (values: Record<string, string>) => Object.assign(SETTINGS, values),
  getAllSettings: () => ({ ...SETTINGS }),
  getServerPort: (engine: string) =>
    engine === "llama.cpp" ? (SETTINGS.SERVER_PORT || "18080") : (SETTINGS.VLLM_PORT || "8081"),
  setActiveServerPortOverride: (port: string | null) => {
    PORT_OVERRIDE = port;
  },
  getActiveServerPort: () => PORT_OVERRIDE ?? SETTINGS.SERVER_PORT ?? "18080",
}));

const realModelScan = await import("../model-scan");
mock.module("../model-scan", () => ({
  ...realModelScan,
  modelNameForPath: (p: string) => p.split("/").pop() ?? p,
}));

const realModelStore = await import("../model-store");
mock.module("../model-store", () => ({
  ...realModelStore,
  slugModelFileName: (name: string) => name.replace(/\.(gguf|safetensors)$/i, "").toLowerCase(),
}));

// launch-plan 的 getSetting 读的是真 DB（测试临时数据目录），这里换成与 llama 测试同一份
// 内存 settings，保证「缓存 key 由设置拼出」这一环与 buildArgs 读到的是同一份值。
// 注意：mock.module 必须**晚于** llama 的导入（llama 在测试文件末尾才 await import，先跑到这里），
// 否则 mock 对 llama 内已冻结的绑定无效。这里 import 只是拿真实函数引用供 seedPlan 用。

const realStats = await import("../stats");
mock.module("../stats", () => ({
  ...realStats,
  markServerStarted: () => {},
}));

const { LlamaRuntime, isProjectorFailure } = await import("./llama");

// T4e 回读用例的假模块（proc / app-log / llama-flash-attn）在模块顶层导入真实引用，
// beforeAll 里再 mock.module 叠覆盖、afterAll 换回。
const realProc = await import("./proc");
const realAppLog = await import("../app-log");
const realFlashAttn = await import("./llama-flash-attn");

const tmpDir = mkdtempSync(join(tmpdir(), "llama-runtime-test-"));
const chatModel = join(tmpDir, "e2e-chat.gguf");
const embedModel = join(tmpDir, "wemm-emb.gguf");
writeFileSync(chatModel, "gguf");
writeFileSync(embedModel, "gguf");

/**
 * mmproj 注入场景目录：每个目录自包含（模型 + 不同投影文件组合），
 * 验证自动配对与选择规则（多文件优先 f16）—— 聊天与嵌入实例走同一套规则。
 * 内容写 GGUF 魔数：配对前会校验文件头，假文件不该被当成投影文件配上去。
 */
function scenarioDir(name: string, files: string[]): string {
  const dir = join(tmpDir, name);
  mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(join(dir, f), "GGUF");
  return dir;
}

const mmprojBothDir = scenarioDir("mmproj-both", ["model.gguf", "mmproj-f16.gguf", "mmproj-bf16.gguf"]);
const mmprojBf16OnlyDir = scenarioDir("mmproj-bf16-only", ["model.gguf", "mmproj-bf16.gguf"]);
const mmprojNoneDir = scenarioDir("mmproj-none", ["model.gguf"]);
// 上游常见的第三种命名：模型名在前（ModelScope 镜像多这么叫）。
const mmprojSuffixDir = scenarioDir("mmproj-suffix", [
  "Qwen3-VL-4B-Q4_K_M.gguf",
  "Qwen3-VL-4B-mmproj-BF16.gguf",
]);
// 名字像投影文件、内容不是 GGUF（放错位置 / 下到一半的杂物）。
const mmprojJunkDir = scenarioDir("mmproj-junk", ["model.gguf", "mmproj-f16.gguf"]);
writeFileSync(join(mmprojJunkDir, "mmproj-f16.gguf"), "not-a-gguf");
// 带侧车、字节没齐的半成品：文件头是 GGUF，拿它启动必然失败（最终文件一开始就被
// 预分配到完整大小，看尺寸看不出没下完 —— 侧车里的 parts 才是权威口径）。
const mmprojPartialDir = scenarioDir("mmproj-partial", ["model.gguf", "mmproj-f16.gguf"]);
writeFileSync(
  join(mmprojPartialDir, "mmproj-f16.gguf.download.json"),
  JSON.stringify({
    total: 1_000_000,
    flushed: 0,
    parts: [{ index: 0, start: 0, end: 1_000_000, have: 0 }],
  }),
);

/** 模块级共用：一份中性计划（T4e 回读用例与 auto-tune 用例都注入缓存）。 */
function makePlan(overrides: Partial<LaunchPlan> = {}): LaunchPlan {
  return {
    ctxTokens: 131072,
    ctxPerSlot: 43690,
    parallel: 3,
    batch: 1024,
    ubatch: 256,
    cacheTypeK: "q8_0",
    cacheTypeV: "q8_0",
    flashAttn: true,
    kvUnified: true,
    gpuLayers: null,
    fits: true,
    estimates: {
      budgetBytes: Math.round(7.8 * 1024 ** 3),
      weightsBytes: 4 * 1024 ** 3,
      kvBytes: Math.round(4.8 * 1024 ** 3),
      computeBufferBytes: 64 * 1024 * 1024,
      ctxComputeBytes: 128 * 1024 * 1024,
      totalBytes: Math.round(9.0 * 1024 ** 3),
      overflowBytes: 0,
    },
    reasons: [{ code: "budget.vram" }, { code: "ctx.reduced" }],
    ...overrides,
  };
}

/** 按 llama 自己的 key 规则把计划注进缓存（模型必须是临时目录里真存在的 .gguf）。 */
function seedPlan(modelPath: string, plan: LaunchPlan): void {
  __setLaunchPlanForTest(
    buildLaunchPlanKeyFromSettings(
      modelPath,
      (k) => SETTINGS[k] ?? "",
      effectiveFlashAttnForPlan(SETTINGS.SERVER_FLASH_ATTN, undefined),
    ),
    plan,
  );
}

/** 与实现同一规则的二进制解析（快照断言需要完整命令行）。 */
const bin =
  ["/opt/homebrew/bin/llama-server", "/usr/local/bin/llama-server"].find((p) => existsSync(p)) ??
  "llama-server";

function setChatSettings() {
  SETTINGS.SERVER_PORT = "18400";
  SETTINGS.SERVER_CTX_SIZE = "8192";
  SETTINGS.SERVER_IMAGE_MAX_TOKENS = "2048";
  SETTINGS.SERVER_BATCH_SIZE = "256";
  SETTINGS.SERVER_UBATCH_SIZE = "64";
  SETTINGS.SERVER_PARALLEL = "1";
  SETTINGS.SERVER_TEMP = "0.1";
  SETTINGS.SERVER_TOP_P = "0.8";
  SETTINGS.SERVER_CACHE_TYPE_K = "q8_0";
  SETTINGS.SERVER_CACHE_TYPE_V = "q8_0";
  // 显式重置 GPU 层数为默认哨兵（-1 = 交给引擎），防止测试间串状态影响自动推算分支。
  SETTINGS.SERVER_GPU_LAYERS = "-1";
}

beforeEach(() => {
  for (const key of Object.keys(SETTINGS)) delete SETTINGS[key];
});

describe("buildCommandLine / chat", () => {
  test("chat 命令行快照：与旧版逐字节一致（聊天路径零变化，③-A2）", () => {
    setChatSettings();
    const rt = new LlamaRuntime();
    const cmd = rt.buildCommandLine(chatModel);
    expect(cmd).toBe(
      `${bin} -m ${chatModel} --alias e2e-chat --host 127.0.0.1 --port 18400 --ctx-size 8192` +
        " --image-max-tokens 2048 --parallel 1 --batch-size 256 --ubatch-size 64" +
        " --cache-type-k q8_0 --cache-type-v q8_0 --repeat-penalty 1.12 --repeat-last-n 256" +
        " --temp 0.1 --top-p 0.8 --top-k 40 --no-mmproj-offload",
    );
  });

  test("加载模式：设置值不会以原始形态进 argv（白名单之外一律不发，防参数注入）", () => {
    setChatSettings();
    // 这个值最终进 argv，所以合法取值是白名单；手改设置行塞进来的坏值必须被丢掉。
    SETTINGS.SERVER_LOAD_MODE = "--evil-flag";
    const cmd = new LlamaRuntime().buildCommandLine(chatModel);
    expect(cmd).not.toContain("--evil-flag");
    // 合法值在「还没探测过这台 llama-server」时也不发 —— 宁可按默认启动，不赌开关存在
    // （探测结果按二进制路径缓存，一旦启动过就会带上；映射规则见 llama-load-mode.test.ts）。
    SETTINGS.SERVER_LOAD_MODE = "mlock";
    expect(new LlamaRuntime().buildCommandLine(chatModel)).not.toContain("--evil-flag");
  });

  test("采样参数「设置优先、模型档案兜底」：设置页显示的就是发出去的那份（ENG-04）", () => {
    setChatSettings();
    // 档案默认值（模型自带的那套）
    const fromProfile = new LlamaRuntime().buildCommandLine(chatModel);
    expect(fromProfile).toContain("--repeat-penalty 1.12");
    expect(fromProfile).toContain("--temp 0.1");
    expect(fromProfile).toContain("--top-p 0.8");
    expect(fromProfile).toContain("--top-k 40");
    // 设置盖过档案
    SETTINGS.SERVER_TOP_K = "7";
    SETTINGS.SERVER_REPEAT_PENALTY = "1.3";
    const cmd = new LlamaRuntime().buildCommandLine(chatModel);
    expect(cmd).toContain("--top-k 7");
    expect(cmd).toContain("--repeat-penalty 1.3");
    // 空串 = 没设过，落回档案的默认值（而不是把参数发成空）
    SETTINGS.SERVER_TOP_K = "";
    expect(new LlamaRuntime().buildCommandLine(chatModel)).toContain("--top-k 40");
  });
});

describe("buildCommandLine / embedding", () => {
  test("embedding 实例：追加 --embeddings --pooling，裁剪聊天采样参数，端口用 overrides", () => {
    setChatSettings();
    const rt = new LlamaRuntime({
      model: embedModel,
      port: "18500",
      servedName: "wemm",
      purpose: "embedding",
    });
    const cmd = rt.buildCommandLine();
    expect(cmd).toBe(
      `${bin} -m ${embedModel} --alias wemm --host 127.0.0.1 --port 18500 --ctx-size 8192` +
        " --parallel 1 --batch-size 8192 --ubatch-size 8192 --cache-type-k q8_0 --cache-type-v q8_0" +
        " --embeddings --pooling last --no-mmproj-offload",
    );
  });

  test("嵌入模式物理 batch 取 ctx-size：超过它的输入会让 llama.cpp 崩进程（KB 导入即崩的根因）", () => {
    setChatSettings();
    const mk = () => new LlamaRuntime({ model: embedModel, purpose: "embedding" }).buildCommandLine();
    // ctx 8192 → batch/ubatch 8192（不能沿用聊天调优的 256/64：--embeddings 下
    // llama.cpp 强制 n_batch = n_ubatch，512 的物理 batch 塞不下真实文档）
    const cmd = mk();
    expect(cmd).toContain("--batch-size 8192 --ubatch-size 8192");
    // ctx 调大时 batch 跟着走，不留静默上限
    SETTINGS.SERVER_CTX_SIZE = "32768";
    expect(mk()).toContain("--batch-size 32768 --ubatch-size 32768");
    // 聊天路径不受影响（仍是聊天调优的 256/64）
    expect(new LlamaRuntime({ model: chatModel, servedName: "chat" }).buildCommandLine()).toContain(
      "--batch-size 256 --ubatch-size 64",
    );
  });

  test("无 overrides.port 时端口回落 EMBEDDING_PORT（18190 段，③-A1a）", () => {
    SETTINGS.EMBEDDING_PORT = "18190";
    const rt = new LlamaRuntime({ model: embedModel, purpose: "embedding" });
    const cmd = rt.buildCommandLine();
    expect(cmd).toContain("--port 18190");
    // alias 未显式给时按文件名 slug 生成。
    expect(cmd).toContain("--alias wemm-emb");
  });

  test("pooling 跟随设置键（EMBEDDING_POOLING）", () => {
    SETTINGS.EMBEDDING_POOLING = "mean";
    const rt = new LlamaRuntime({
      model: embedModel,
      port: "18500",
      purpose: "embedding",
    });
    const cmd = rt.buildCommandLine();
    expect(cmd).toContain("--pooling mean");
    expect(cmd).not.toContain("--temp");
  });

  test("裁剪清单：--temp/--top-p/--repeat-penalty/--repeat-last-n/--image-max-tokens 都不发", () => {
    setChatSettings();
    const rt = new LlamaRuntime({ model: embedModel, port: "18500", purpose: "embedding" });
    const cmd = rt.buildCommandLine();
    for (const flag of ["--temp", "--top-p", "--repeat-penalty", "--repeat-last-n", "--image-max-tokens"]) {
      expect(cmd).not.toContain(flag);
    }
    // 保留清单：上下文 / batch / 缓存类型仍在。
    for (const flag of ["--ctx-size", "--batch-size", "--ubatch-size", "--cache-type-k", "--cache-type-v"]) {
      expect(cmd).toContain(flag);
    }
  });

  test("purpose 不传即 chat：overrides 只差端口时命令仍是聊天形态", () => {
    setChatSettings();
    const rt = new LlamaRuntime({ model: chatModel, port: "18405" });
    const cmd = rt.buildCommandLine();
    expect(cmd).toContain("--port 18405");
    expect(cmd).toContain("--temp 0.1");
    expect(cmd).not.toContain("--embeddings");
  });
});

describe("buildArgs / mmproj 注入", () => {
  /** 嵌入实例命令行：模型与投影文件同目录的场景。 */
  function embedCmd(modelPath: string): string {
    setChatSettings();
    return new LlamaRuntime({
      model: modelPath,
      port: "18500",
      purpose: "embedding",
    }).buildCommandLine();
  }
  test("同目录有 f16 + bf16 → 注入一个 --mmproj 且选 f16", () => {
    const cmd = embedCmd(join(mmprojBothDir, "model.gguf"));
    expect(cmd).toContain(`--mmproj ${join(mmprojBothDir, "mmproj-f16.gguf")}`);
    expect(cmd.split("--mmproj").length).toBe(2);
  });

  test("只有 bf16 → 选它（f16 缺席时字典序首个兜底）", () => {
    const cmd = embedCmd(join(mmprojBf16OnlyDir, "model.gguf"));
    expect(cmd).toContain(`--mmproj ${join(mmprojBf16OnlyDir, "mmproj-bf16.gguf")}`);
  });

  test("同目录无 mmproj → 不注入（行为与旧版一致）", () => {
    const cmd = embedCmd(join(mmprojNoneDir, "model.gguf"));
    expect(cmd).not.toContain("--mmproj");
  });

  /**
   * 聊天实例必须注入 —— 这正是「上传图片提示缺 mmproj，可文件明明已经下好」的根因：
   * GGUF 的视觉塔在独立文件里，不传 --mmproj 的 VLM 起得来、纯文本也正常，
   * 只有图片请求被服务端拒。旧行为（聊天永不注入）已作废。
   */
  test("聊天实例也注入：同目录有投影文件时带上 --mmproj", () => {
    setChatSettings();
    const rt = new LlamaRuntime({ model: join(mmprojBothDir, "model.gguf"), port: "18406" });
    const cmd = rt.buildCommandLine();
    expect(cmd).toContain(`--mmproj ${join(mmprojBothDir, "mmproj-f16.gguf")}`);
    // 聊天形态不变：采样参数与 --image-max-tokens 仍在，注入的是多一个投影文件
    expect(cmd).toContain("--temp 0.1");
    expect(cmd).toContain("--image-max-tokens 2048");
    expect(cmd).not.toContain("--embeddings");
  });

  test("聊天实例：模型名在前命名的投影文件（Qwen3-VL-4B-mmproj-BF16.gguf）也认", () => {
    setChatSettings();
    const rt = new LlamaRuntime({ model: join(mmprojSuffixDir, "Qwen3-VL-4B-Q4_K_M.gguf"), port: "18407" });
    const cmd = rt.buildCommandLine();
    expect(cmd).toContain(`--mmproj ${join(mmprojSuffixDir, "Qwen3-VL-4B-mmproj-BF16.gguf")}`);
  });

  test("聊天实例：同目录没有投影文件 → 不带 --mmproj（纯文本模型零变化）", () => {
    setChatSettings();
    const cmd = new LlamaRuntime({ model: chatModel, port: "18408" }).buildCommandLine();
    expect(cmd).not.toContain("--mmproj");
  });

  /**
   * 配对是猜的，所以宁可少配也不配错：llama-server 遇到加载不了的投影文件会直接
   * 退出（实测 0.4.0/b10809：`[mtmd] failed to load multimodal model` →
   * `exiting due to model loading error`），一个坏文件就能把能跑的模型变成起不来。
   */
  test("内容不是 GGUF 的同名文件不配（放错位置的杂物）", () => {
    setChatSettings();
    const cmd = new LlamaRuntime({ model: join(mmprojJunkDir, "model.gguf"), port: "18409" }).buildCommandLine();
    expect(cmd).not.toContain("--mmproj");
  });

  test("下到一半的投影文件（有侧车、字节没齐）不配", () => {
    setChatSettings();
    const cmd = new LlamaRuntime({ model: join(mmprojPartialDir, "model.gguf"), port: "18410" }).buildCommandLine();
    expect(cmd).not.toContain("--mmproj");
  });

  test("hf ref 嵌入模型（-hf 自管缓存）不注入 mmproj（Non-Goal）", () => {
    setChatSettings();
    const rt = new LlamaRuntime({
      model: "unsloth/gme-Qwen2-VL-2B-GGUF",
      port: "18500",
      purpose: "embedding",
    });
    const cmd = rt.buildCommandLine();
    expect(cmd).toContain("-hf unsloth/gme-Qwen2-VL-2B-GGUF");
    expect(cmd).not.toContain("--mmproj");
  });
});

describe("isProjectorFailure", () => {
  test("投影文件坏 / 不匹配（实测原文）→ 命中", () => {
    expect(
      isProjectorFailure(
        "E gguf_init_from_reader: invalid magic characters: 'not-', expected 'GGUF'\n" +
          "E mtmd_init_from_file: error: Failed to load CLIP model from /m/mmproj-f16.gguf\n" +
          "E srv load_model: failed to load multimodal model, '/m/mmproj-f16.gguf'\n" +
          "E srv llama_server: exiting due to model loading error",
      ),
    ).toBe(true);
  });

  test("模型本身的问题（显存不足 / 文件缺失）→ 不命中，不重试", () => {
    expect(
      isProjectorFailure(
        "E srv load_model: failed to load model '/m/model.gguf'\n" +
          "E llama_model_load: error loading model: unable to allocate CUDA0 buffer\n" +
          "E srv llama_server: exiting due to model loading error",
      ),
    ).toBe(false);
  });
});
describe("buildArgs / 自动启动参数（SERVER_AUTO_TUNE）", () => {
  /** 一份可用的计划：只改与断言相关的字段，其余给中性值。 */
  function makePlan(overrides: Partial<LaunchPlan> = {}): LaunchPlan {
    return {
      ctxTokens: 131072,
      ctxPerSlot: 43690,
      parallel: 3,
      batch: 1024,
      ubatch: 256,
      cacheTypeK: "q8_0",
      cacheTypeV: "q8_0",
      flashAttn: true,
      kvUnified: true,
      gpuLayers: null,
      fits: true,
      estimates: {
        budgetBytes: Math.round(7.8 * 1024 ** 3),
        weightsBytes: 4 * 1024 ** 3,
        kvBytes: Math.round(4.8 * 1024 ** 3),
        computeBufferBytes: 64 * 1024 * 1024,
        ctxComputeBytes: 128 * 1024 * 1024,
        totalBytes: Math.round(9.0 * 1024 ** 3),
        overflowBytes: 0,
      },
      reasons: [{ code: "budget.vram" }, { code: "ctx.reduced" }],
      ...overrides,
    };
  }

  /**
   * 把一份计划按 llama 自己的 key 规则注进缓存。key 与 llama.ts 共用同一构造函数
   * （buildLaunchPlanKeyFromSettings），从根上消灭两份规则各自演化导致的不一致。
   * 模型必须是临时目录里的真 .gguf（cachedLaunchPlan 会重新 stat 比对指纹，文件不存在会未命中）。
   */
  function seedPlan(modelPath: string, plan: LaunchPlan): void {
    __setLaunchPlanForTest(
      buildLaunchPlanKeyFromSettings(
        modelPath,
        (k) => SETTINGS[k] ?? "",
        effectiveFlashAttnForPlan(SETTINGS.SERVER_FLASH_ATTN, undefined),
      ),
      plan,
    );
  }

  test("开启但缓存没有计划 → argv 与关闭时完全一致（任何失败都不能挡住启动）", () => {
    setChatSettings();
    SETTINGS.SERVER_AUTO_TUNE = "1";
    const withAuto = new LlamaRuntime({ model: chatModel, port: "18410" }).buildArgs(
      { kind: "local", path: chatModel, alias: "e2e-chat" },
      DEFAULT_CUSTOM_SERVER_ARGS,
    );
    SETTINGS.SERVER_AUTO_TUNE = "0";
    const without = new LlamaRuntime({ model: chatModel, port: "18410" }).buildArgs(
      { kind: "local", path: chatModel, alias: "e2e-chat" },
      DEFAULT_CUSTOM_SERVER_ARGS,
    );
    expect(withAuto).toEqual(without);
  });

  test("开启且缓存有计划 → ctx / batch / ubatch 用计划值，parallel 用设置值", () => {
    setChatSettings();
    SETTINGS.SERVER_AUTO_TUNE = "1";
    SETTINGS.SERVER_CTX_SIZE = "8192";
    SETTINGS.SERVER_BATCH_SIZE = "256";
    SETTINGS.SERVER_UBATCH_SIZE = "64";
    SETTINGS.SERVER_PARALLEL = "3";
    seedPlan(chatModel, makePlan());

    const rt = new LlamaRuntime({ model: chatModel, port: "18411" });
    const cmd = rt.buildCommandLine(chatModel);
    expect(cmd).toContain("--ctx-size 131072");
    expect(cmd).toContain("--batch-size 1024");
    expect(cmd).toContain("--ubatch-size 256");
    // 并发是用户的业务选择：计划里的 parallel 不覆盖设置值
    expect(cmd).toContain("--parallel 3");
    // 缓存类型保持设置值（它们参与 key 计算，不参与覆盖）
    expect(cmd).toContain("--cache-type-k q8_0");
    expect(cmd).toContain("--cache-type-v q8_0");
  });

  test("gpuLayers 只在 SERVER_GPU_LAYERS == -1 时采纳；用户填了具体数字就听用户的", () => {
    setChatSettings();
    SETTINGS.SERVER_AUTO_TUNE = "1";
    const plan = makePlan({ gpuLayers: 20 });

    // 用户未显式指定（默认 -1）→ 采纳计划的 20
    seedPlan(chatModel, plan);
    let rt = new LlamaRuntime({ model: chatModel, port: "18412" });
    expect(rt.buildCommandLine(chatModel)).toContain("--n-gpu-layers 20");

    // 用户填了具体数字 → 听用户的
    SETTINGS.SERVER_GPU_LAYERS = "28";
    rt = new LlamaRuntime({ model: chatModel, port: "18412" });
    expect(rt.buildCommandLine(chatModel)).toContain("--n-gpu-layers 28");
    expect(rt.buildCommandLine(chatModel)).not.toContain("--n-gpu-layers 20");
  });

  test("buildCommandLine 与 buildArgs 在同一缓存状态下产生相同的参数序列", () => {
    setChatSettings();
    SETTINGS.SERVER_AUTO_TUNE = "1";
    seedPlan(chatModel, makePlan({ gpuLayers: 12 }));

    const rt = new LlamaRuntime({ model: chatModel, port: "18413" });
    const viaBuildArgs = rt.buildArgs(
      { kind: "local", path: chatModel, alias: "e2e-chat" },
      rt.getProfileServerArgs(),
    );
    // buildArgs 与 buildCommandLine 内部是同一份函数，参数序列必然逐字节一致
    // （「复制的命令」与实际发出去的那条不会分叉）。
    const viaCommandLine = rt.buildCommandLine(chatModel).replace(/^\S+\s+/, ""); // 去掉二进制路径
    expect(viaCommandLine).toBe(viaBuildArgs.join(" "));

    // 真正有价值的一致性：同一 key 写缓存后，两个入口读到的计划相同 ——
    // buildCommandLine 里那份（含 GPU 层建议）与 buildArgs 里那份逐字段一致。
    const plan = makePlan({ gpuLayers: 12 });
    seedPlan(chatModel, plan);
    const rt2 = new LlamaRuntime({ model: chatModel, port: "18414" });
    const fromCommandLine = rt2.buildCommandLine(chatModel);
    expect(fromCommandLine).toContain("--n-gpu-layers 12");
    expect(fromCommandLine).toContain("--ctx-size 131072");
    const fromArgs = rt2.buildArgs(
      { kind: "local", path: chatModel, alias: "e2e-chat" },
      rt2.getProfileServerArgs(),
    );
    expect(fromArgs.join(" ")).toBe(fromCommandLine.replace(/^\S+\s+/, ""));
  });
});

describe("buildArgs / flash attention（T4d）", () => {
  // 探测结果按二进制路径进程级缓存（llama-flash-attn.ts）：这些测试用「本机解析出的那个
  // llama-server」同一个路径注缓存，测完 clearServerHelpSupportCache 恢复未探测状态，
  // 与真实「启动前」一致（未探测 = none，一个参数都不发）。
  const { setCachedServerHelpSupport, clearServerHelpSupportCache } =
    require("./llama-flash-attn") as typeof import("./llama-flash-attn");

  const resolvedBin = () =>
    ["/opt/homebrew/bin/llama-server", "/usr/local/bin/llama-server"].find((p) => existsSync(p)) ??
    "llama-server";

  const chatArgs = (rt: InstanceType<typeof LlamaRuntime>) =>
    rt.buildArgs(
      { kind: "local", path: chatModel, alias: "e2e-chat" },
      DEFAULT_CUSTOM_SERVER_ARGS,
    );

  /**
   * 断言 argv（string[]）里 `flag` 紧跟 `value`。
bun 的数组 toContain 是精确匹配（单元素），
   * 不能用 toContain("--flash-attn auto") 这种字符串子序列写法，所以拆成两个断言。
   */
  function expectFlagWithValue(args: string[], flag: string, value: string) {
    const i = args.indexOf(flag);
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe(value);
  }

  /** 断言 argv 里**没有**该 flag（精确元素匹配，不是子串）。 */
  function expectNoFlag(args: string[], flag: string) {
    expect(args).not.toContain(flag);
  }

  afterEach(() => clearServerHelpSupportCache());

  test("tristate：--help 含取值列表 → auto 发 --flash-attn auto（#1）", () => {
    setChatSettings();
    const rt = new LlamaRuntime({ model: chatModel, port: "18420" });
    // 未探测状态先验证不发（#4 的另一半）
    expectNoFlag(chatArgs(rt), "--flash-attn");

    // 注一次「探测成功：三态」（不跑真 --help，保证确定性）
    setCachedServerHelpSupport(resolvedBin(), { loadMode: "load-mode", flashAttn: "tristate" });

    // 默认 auto
    expectFlagWithValue(chatArgs(rt), "--flash-attn", "auto");
    // on / off 原样发
    SETTINGS.SERVER_FLASH_ATTN = "on";
    expectFlagWithValue(chatArgs(rt), "--flash-attn", "on");
    SETTINGS.SERVER_FLASH_ATTN = "off";
    expectFlagWithValue(chatArgs(rt), "--flash-attn", "off");
  });

  test("boolean：老版只有 -fa, --flash-attn → on 发不带值的开关，auto 不发（#2）", () => {
    setChatSettings();
    setCachedServerHelpSupport(resolvedBin(), { loadMode: "legacy", flashAttn: "boolean" });
    const rt = new LlamaRuntime({ model: chatModel, port: "18421" });

    SETTINGS.SERVER_FLASH_ATTN = "auto";
    const autoArgs = chatArgs(rt);
    expectNoFlag(autoArgs, "--flash-attn");

    SETTINGS.SERVER_FLASH_ATTN = "on";
    const onArgs = chatArgs(rt);
    const idx = onArgs.indexOf("--flash-attn");
    expect(idx).toBeGreaterThan(-1);
    expect(onArgs[idx + 1]).not.toBe("on"); // 不带值（下一段是别的东西，比如 -m 或 --no-mmproj-offload）

    SETTINGS.SERVER_FLASH_ATTN = "off";
    expectNoFlag(chatArgs(rt), "--flash-attn");
  });

  test("none：--help 里没有 flash-attn → argv 完全不包含（#3）", () => {
    setChatSettings();
    setCachedServerHelpSupport(resolvedBin(), { loadMode: "load-mode", flashAttn: "none" });
    const rt = new LlamaRuntime({ model: chatModel, port: "18422" });
    for (const v of ["auto", "on", "off"]) {
      SETTINGS.SERVER_FLASH_ATTN = v;
      expectNoFlag(chatArgs(rt), "--flash-attn");
    }
  });

  test("未探测状态：buildCommandLine 与 buildArgs 都不发该参数（#4）", () => {
    setChatSettings();
    // clearServerHelpSupportCache 在 afterEach 里已跑；再清一次保证
    clearServerHelpSupportCache();
    const rt = new LlamaRuntime({ model: chatModel, port: "18423" });
    SETTINGS.SERVER_FLASH_ATTN = "on";
    const cmd = rt.buildCommandLine(chatModel);
    expect(cmd).not.toContain("--flash-attn");
    const args = chatArgs(rt);
    expectNoFlag(args, "--flash-attn");
    // 两者一致（同一份缓存、同一份函数）
    expect(cmd.replace(/^\S+\s+/, "")).toBe(args.join(" "));
  });

  test("SERVER_FLASH_ATTN=off（tristate）→ argv 含 --flash-attn off（#5）", () => {
    setChatSettings();
    setCachedServerHelpSupport(resolvedBin(), { loadMode: "load-mode", flashAttn: "tristate" });
    SETTINGS.SERVER_FLASH_ATTN = "off";
    const rt = new LlamaRuntime({ model: chatModel, port: "18424" });
    expectFlagWithValue(chatArgs(rt), "--flash-attn", "off");
  });

  test("设置值白名单：非法值回落 auto，不产生 argv 注入（tristate）", () => {
    setChatSettings();
    setCachedServerHelpSupport(resolvedBin(), { loadMode: "load-mode", flashAttn: "tristate" });
    SETTINGS.SERVER_FLASH_ATTN = "--evil-flag";
    const rt = new LlamaRuntime({ model: chatModel, port: "18425" });
    const args = chatArgs(rt);
    expectNoFlag(args, "--evil-flag");
    // 回落 auto
    expectFlagWithValue(args, "--flash-attn", "auto");
  });
});

// ---------- T4e：启动后回读实测值（预测 → 实测闭环） ----------

describe("start / 回读实测值（T4e）", () => {
  const originalFetch = globalThis.fetch;

  type LogEventInput = Parameters<typeof realAppLog.logEvent>[0];
  let logEvents: LogEventInput[];
  let propsBehavior: "ok" | "fail";
  let faLogLine: string;
  let realSpawn: typeof realProc.spawnServerProcess;
  let realProbe: typeof realFlashAttn.probeServerHelp;

  beforeAll(async () => {
    // 让 checkBinary 能找到“已安装”的 llama-server：在临时数据目录的托管路径造一个空文件。
    // （probeServerHelp 已桩掉，这个文件不会被真正执行。）
    const binPath = llamaCppBinaryPath();
    mkdirSync(dirname(binPath), { recursive: true });
    if (!existsSync(binPath)) writeFileSync(binPath, "#!/bin/sh\n");

    // 桩只叠覆盖、其余保持真实（mock-hygiene）；app-log 收进数组供断言。
    await mockModulePartial<typeof import("../app-log")>("./app-log", {
      logEvent: (input: LogEventInput) => {
        logEvents.push(input);
        return {
          ...input,
          level: input.level ?? "info",
          seq: logEvents.length,
          ts: Date.now(),
          pid: 1,
        };
      },
    });
    logEvents = [];

    // 假 fetch：/health 永远 OK；/props 按用例行为（JSON / 抛错）。
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/health")) return new Response(null, { status: 200 });
      if (url.endsWith("/props")) {
        if (propsBehavior === "fail") throw new Error("connection refused (fake)");
        return new Response(
          JSON.stringify({
            default_generation_settings: { params: {}, n_ctx: 65536 },
            total_slots: 3,
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;

    // 假子进程：把启动日志（含 FA 措辞）灌进 appendLog，exited 永不兑现（实例一直活着）。
    // stdout 用真 ReadableStream 把 faLogLine 吐出（pumpServerOutput 会读它），
    // stderr 空流。
    realSpawn = realProc.spawnServerProcess;
    mock.module("./proc", () => ({
      ...realProc,
      spawnServerProcess: () => {
        const makeStream = () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              const text = faLogLine;
              if (text) controller.enqueue(new TextEncoder().encode(text));
              controller.close();
            },
          });
        return {
          pid: 4242,
          exited: new Promise<number>(() => {}),
          stdout: makeStream(),
          stderr: makeStream(),
          kill: () => {},
        } as never;
      },
    }));

    // --help 探测桩（不真 spawn，避免测试里拉起外部二进制）。
    realProbe = realFlashAttn.probeServerHelp;
    mock.module("./llama-flash-attn", () => ({
      ...realFlashAttn,
      probeServerHelp: async () => ({ loadMode: "unknown", flashAttn: "none" as const }),
    }));
  });

  beforeEach(() => {
    logEvents = [];
    propsBehavior = "ok";
    faLogLine = "";
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    mock.module("./proc", () => ({ ...realProc, spawnServerProcess: realSpawn }));
    mock.module("./llama-flash-attn", () => ({
      ...realFlashAttn,
      probeServerHelp: realProbe,
    }));
    mock.module("../app-log", () => ({ ...realAppLog }));
  });

  /** 起一个“模型文件存在的”实例并等启动完成（含回读）。 */
  async function startServer(port: number): Promise<{
    result: { ok: boolean; error?: string };
    status: string;
    logs: string;
  }> {
    const rt = new LlamaRuntime({ model: chatModel, port: String(port) });
    const result = await rt.start();
    await Bun.sleep(100); // 等假子进程的 appendLog 微任务兑现（FA 措辞进日志）
    return { result, status: rt.getStatus(), logs: rt.getLogs() };
  }

  const eventsBy = (name: string) => logEvents.filter((e) => e.event === name);

  test("/props 成功 → launch_plan.measured 的 actualCtxTotal = n_ctx × total_slots", async () => {
    propsBehavior = "ok";
    faLogLine = "llama_context: flash_attn            = enabled\n";
    // 让回读能带上预测字段：开自动并注入一份计划
    SETTINGS.SERVER_AUTO_TUNE = "1";
    seedPlan(chatModel, makePlan({ ctxTokens: 131072, ctxPerSlot: 43690 }));

    const { result, status, logs } = await startServer(18500);
    expect(result.ok).toBe(true);
    expect(status).toBe("running");
    expect(logs).toContain("flash_attn            = enabled");

    const measured = eventsBy("launch_plan.measured");
    expect(measured.length).toBe(1);
    const detail = (measured[0]?.detail ?? {}) as Record<string, number | string | null | undefined>;
    expect(detail.actualCtxPerSlot).toBe(65536);
    expect(detail.actualSlots).toBe(3);
    expect(detail.actualCtxTotal).toBe(196608); // 65536 × 3
    expect(detail.flashAttn).toBe("on");
    expect(detail.predictedCtx).toBe(131072);
    expect(detail.predictedPerSlot).toBe(43690);
    // 预测 131072 vs 实测 196608 相差 > 5% → 额外一条 mismatch
    const mismatch = eventsBy("launch_plan.mismatch");
    expect(mismatch.length).toBe(1);
    const mDetail = (mismatch[0]?.detail ?? {}) as Record<string, number>;
    expect(mDetail.predictedCtx).toBe(131072);
    expect(mDetail.actualCtxTotal).toBe(196608);
  });

  test("/props 失败 → 启动仍成功、状态 running，回读异常只记 readback_failed", async () => {
    propsBehavior = "fail";
    faLogLine = "";
    const { result, status } = await startServer(18501);
    expect(result.ok).toBe(true);
    expect(status).toBe("running");
    // fetch 抛错在回读内部被吞 → 记一条 readback_failed（warn），启动不受影响
    expect(eventsBy("launch_plan.readback_failed").length).toBe(1);
  });

  test("日志含 flash_attn = enabled → SERVER_FLASH_ATTN_EFFECTIVE 被写成 on", async () => {
    propsBehavior = "ok";
    faLogLine = "llama_context: flash_attn            = enabled\n";
    // 先放一个旧值，验证它会被覆盖
    realSettings.updateSettings({ SERVER_FLASH_ATTN_EFFECTIVE: "off" });
    const { result } = await startServer(18502);
    expect(result.ok).toBe(true);
    expect(realSettings.getSetting("SERVER_FLASH_ATTN_EFFECTIVE")).toBe("on");
  });

  test("日志判断不出 FA → 设置保持原值不变", async () => {
    propsBehavior = "ok";
    faLogLine = "llama_model_loader: - full model: qwen\n"; // 无任何 FA 措辞
    realSettings.updateSettings({ SERVER_FLASH_ATTN_EFFECTIVE: "off" });
    const { result } = await startServer(18503);
    expect(result.ok).toBe(true);
    expect(realSettings.getSetting("SERVER_FLASH_ATTN_EFFECTIVE")).toBe("off");
  });
});

