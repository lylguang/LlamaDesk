import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { ServerStatus } from "./runtimes/types";
import { mockModulePartial } from "./test-mocks";

/**
 * 启动门面：配置的模型起不来时按备选链回退（PERF-03）。
 *
 * 桩掉调度层，只测门面自己的判断：
 *   1. 只有**模型侧**失败才回退（端口被占 / 缺依赖换哪个模型都一样，回退会盖住真原因）；
 *   2. 回退是有痕迹的：写日志 + 进通知中心，不静默换模型；
 *   3. 整条链都起不来时，错误里两边的失败原因都在（不是只剩一句「备选也失败」）。
 */

const SETTINGS: Record<string, string> = {};
await mockModulePartial<typeof import("./db/settings")>("./db/settings", {
  getSetting: (key) => SETTINGS[key] ?? "",
  getNumericSetting: (key) => Number(SETTINGS[key] ?? 0) || 0,
  updateSettings: (values) => Object.assign(SETTINGS, values),
  getAllSettings: () => ({ ...SETTINGS }),
  getServerPort: (engine) =>
    engine === "llama.cpp" ? SETTINGS.SERVER_PORT || "8080" : SETTINGS.VLLM_PORT || "8081",
  getActiveServerPort: () => SETTINGS.SERVER_PORT || "8080",
  setActiveServerPortOverride: () => {},
});

/** 这些目标一启动就失败，值是错误原文（按模型路径区分场景）。 */
const FAILING = new Map<string, string>();

class FakeRuntime {
  readonly id = "fake";
  readonly label = "Fake Engine";
  status: ServerStatus = "stopped";
  logs = "";
  pid = 4242;
  readonly logCbs = new Set<(text: string) => void>();
  readonly statusCbs = new Set<(status: ServerStatus) => void>();
  lastError = "";

  constructor(readonly overrides: { model?: string; port?: string } = {}) {}

  checkBinary = async () => ({ found: true, path: "/fake/bin" });
  buildCommandLine = () => "fake";
  start = async () => {
    const model = this.overrides.model ?? "";
    this.status = "starting";
    this.emitStatus();
    const failure = FAILING.get(model);
    if (failure) {
      this.lastError = failure;
      this.status = "error";
      this.emitStatus();
      return { ok: false, error: failure };
    }
    this.status = "running";
    this.emitStatus();
    return { ok: true };
  };
  stop = async () => {
    this.status = "stopped";
    this.emitStatus();
  };
  restart = () => this.start();
  forceKill = () => {
    this.status = "stopped";
  };
  getStatus = () => this.status;
  getPid = () => (this.status === "stopped" ? undefined : this.pid);
  getLogs = () => this.logs;
  getLastError = () => this.lastError;
  clearLogs = () => {
    this.logs = "";
  };
  onLog = (cb: (text: string) => void) => {
    this.logCbs.add(cb);
    return () => this.logCbs.delete(cb);
  };
  onStatusChange = (cb: (status: ServerStatus) => void) => {
    this.statusCbs.add(cb);
    return () => {
      this.statusCbs.delete(cb);
    };
  };
  emitStatus() {
    for (const cb of this.statusCbs) cb(this.status);
  }
}

await mockModulePartial<typeof import("./runtimes")>("./runtimes", {
  createRuntime: (_engine, overrides) => new FakeRuntime(overrides),
});

await mockModulePartial<typeof import("./runtimes/mlx")>("./runtimes/mlx", {
  mlxRequestModelId: (target: string) => `/abs/${target}`,
  isMlxActive: () => SETTINGS.INFERENCE_ENGINE === "mlx",
  resolveMlxModel: () => ({ model: "", requestModelId: "" }),
});

await mockModulePartial<typeof import("./model-store")>("./model-store", {
  listInstalledModels: () => [],
  servedNameForModelPath: (path: string) =>
    (path.split("/").pop() ?? path).replace(/\.(gguf|safetensors)$/i, "").toLowerCase(),
  slugModelFileName: (name: string) => name.replace(/\.(gguf|safetensors)$/i, "").toLowerCase(),
});

const Manager = await import("./server-manager");
const Served = await import("./model-servers");
const Notifications = await import("./notifications");

const tmpDir = mkdtempSync(join(tmpdir(), "server-manager-test-"));
const modelMain = join(tmpDir, "main.gguf");
const modelBackup = join(tmpDir, "backup.gguf");
const modelThird = join(tmpDir, "third.gguf");
for (const file of [modelMain, modelBackup, modelThird]) writeFileSync(file, "gguf");

beforeEach(async () => {
  for (const key of Object.keys(SETTINGS)) delete SETTINGS[key];
  SETTINGS.INFERENCE_ENGINE = "llama.cpp";
  SETTINGS.SERVER_PORT = "18500";
  SETTINGS.LOCAL_MODEL_PATH = modelMain;
  FAILING.clear();
  await Served.stopAllServed();
});

afterEach(async () => {
  await Served.stopAllServed();
});

describe("startServer 的备选链", () => {
  test("配置的模型能起来时不动备选链", async () => {
    SETTINGS.SERVER_FALLBACK_MODELS = modelBackup;
    const res = await Manager.startServer();
    expect(res.ok).toBe(true);
    expect(res.fellBackTo).toBeUndefined();
    expect(Served.getActiveServedModel()?.modelRef).toBe(modelMain);
  });

  test("模型侧失败（架构不认识）→ 换备选模型，并留下痕迹", async () => {
    SETTINGS.SERVER_FALLBACK_MODELS = modelBackup;
    FAILING.set(modelMain, "Error: unknown model architecture: 'spark2_5'");

    const res = await Manager.startServer();
    expect(res.ok).toBe(true);
    expect(res.fellBackTo).toBe(modelBackup);
    // 回退后活动模型就是起得来的那个（否则对话还是发给已经失败的目标）。
    expect(Served.getActiveServedModel()?.modelRef).toBe(modelBackup);
    // 不静默：通知中心要能看到这次替换。
    const titles = Notifications.listNotifications().map((n) => n.title);
    expect(titles.some((title) => title.includes("备选"))).toBe(true);
  });

  test("端口被占 / 缺依赖这种与模型无关的失败不回退", async () => {
    SETTINGS.SERVER_FALLBACK_MODELS = modelBackup;
    FAILING.set(modelMain, "ERROR: [Errno 98] Address already in use");
    const portTaken = await Manager.startServer();
    expect(portTaken.ok).toBe(false);
    expect(portTaken.fellBackTo).toBeUndefined();
    expect(Served.listServedModels().map((m) => m.modelRef)).toEqual([modelMain]);
    await Served.stopAllServed();

    FAILING.clear();
    FAILING.set(modelMain, "ModuleNotFoundError: No module named 'torch'");
    const missingDep = await Manager.startServer();
    expect(missingDep.ok).toBe(false);
    expect(Served.listServedModels().map((m) => m.modelRef)).toEqual([modelMain]);
  });

  test("第一个备选也起不来时继续往下试", async () => {
    SETTINGS.SERVER_FALLBACK_MODELS = `${modelBackup}, ${modelThird}`;
    FAILING.set(modelMain, "ValueError: Model type deepseek_v41 not supported.");
    FAILING.set(modelBackup, "error loading model: unknown (bad magic)");

    const res = await Manager.startServer();
    expect(res.ok).toBe(true);
    expect(res.fellBackTo).toBe(modelThird);
  });

  test("整条链都起不来：错误里两边的失败原因都在", async () => {
    SETTINGS.SERVER_FALLBACK_MODELS = modelBackup;
    FAILING.set(modelMain, "Error: unknown model architecture: 'spark2_5'");
    FAILING.set(modelBackup, "error loading model: unknown (bad magic)");

    const res = await Manager.startServer();
    expect(res.ok).toBe(false);
    expect(res.error).toContain("unknown model architecture");
    expect(res.error).toContain("bad magic");
  });

  test("没配备选链时行为和以前一样，只报第一个模型的错", async () => {
    FAILING.set(modelMain, "Error: unknown model architecture: 'spark2_5'");
    const res = await Manager.startServer();
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Error: unknown model architecture: 'spark2_5'");
  });

  test("备选链解析：逗号 / 换行都认，去重、丢掉与主模型重复的", async () => {
    SETTINGS.SERVER_FALLBACK_MODELS = `${modelBackup}, ${modelBackup}\n ${modelMain} \n`;
    expect(Manager.fallbackModels()).toEqual([modelBackup, modelMain]);
  });
});
