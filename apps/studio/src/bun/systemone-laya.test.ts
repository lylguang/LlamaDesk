/**
 * 本地 JEV 运行时（laya-mlx）的边界测试。
 *
 * 这台机器上不一定装了 MLX / 下过权重，所以这里**只测不需要真跑推理的部分**：
 * 平台判断、venv 不存在时的状态、worker 脚本在位（打包时会被 copy 出去，缺了就是
 * "权重下载失败"那种查半天的坑）、以及没装运行时时的失败要**说人话**而不是抛异常。
 *
 * 真跑一次 MLX 推理的验证放在 smoke（`scripts/systemone-smoke.ts`），那里才允许
 * 花几十秒去装环境。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import {
  getLayaStatus,
  workerFrame,
  layaDownloadModel,
  layaLoadModel,
  layaModelStates,
  onLayaModelProgress,
  layaEngineDir,
  layaPredict,
  onLayaPhase,
  stopLayaWorker,
  uninstallLayaRuntime,
} from "./systemone-laya";

describe("本地运行时：状态与保护", () => {
  test("worker 脚本与模块同目录（打包后 import.meta.dir 恒为 bun/）", () => {
    const script = path.join(import.meta.dir, "systemone-laya-worker.py");
    expect(existsSync(script)).toBe(true);
  });

  test("引擎目录在数据目录下的 engines/laya", () => {
    expect(layaEngineDir()).toContain(path.join("engines", "laya"));
  });

  test("状态如实反映「没装」：installed=false，平台判断与当前机器一致", async () => {
    const status = await getLayaStatus();
    expect(status.platformSupported).toBe(process.platform === "darwin" && process.arch === "arm64");
    // 测试环境的数据目录是临时目录，venv 必然不存在。
    expect(status.installed).toBe(false);
    expect(status.version).toBe("");
    expect(status.engineDir).toBe(layaEngineDir());
  });

  test("没安装时 layaPredict 返回可读失败，而不是抛异常 / 挂死", async () => {
    const result = await layaPredict({ model: "laya-1", weights: "aac6fef/laya-mlx", state: "s", questions: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });

  test("停一个不存在的 worker 是幂等的", async () => {
    expect(await stopLayaWorker()).toEqual({ ok: true });
    expect(await stopLayaWorker()).toEqual({ ok: true });
  });

  test("卸载一个不存在的运行时是幂等的（权重不在托管目录里，不会被误删）", async () => {
    expect(await uninstallLayaRuntime()).toEqual({ ok: true });
  });

  test("没装运行时：查权重状态返回空数组（界面据此显示「先装引擎」）", async () => {
    expect(await layaModelStates([{ weights: "aac6fef/laya-mlx" }])).toEqual([]);
  });

  test("没装运行时：下载 / 启动都返回可读失败，而不是抛异常", async () => {
    const download = await layaDownloadModel("aac6fef/laya-mlx");
    expect(download.ok).toBe(false);
    if (!download.ok) expect(download.error.length).toBeGreaterThan(0);
    const load = await layaLoadModel("aac6fef/laya-mlx");
    expect(load.ok).toBe(false);
  });

  test("权重下载进度可以订阅与取消订阅", () => {
    const seen: string[] = [];
    const off = onLayaModelProgress((p) => seen.push(p.weights));
    expect(typeof off).toBe("function");
    off();
    expect(seen).toEqual([]);
  });

  test("阶段事件可以订阅与取消订阅", () => {
    const seen: string[] = [];
    const off = onLayaPhase((phase) => seen.push(phase));
    expect(typeof off).toBe("function");
    off();
    // 只是确认订阅接口的形状：真正的阶段推送由安装/加载过程触发。
    expect(seen).toEqual([]);
  });
});

describe("请求帧的 id", () => {
  test("payload 里的 id 不能覆盖生成的请求 id", () => {
    // 这条守的是一个真出现过、而且很难看出来的 bug：`layaDownloadModel` 自带
    // `id: "dl-<weights>"`，拼帧时写的是 `{ id, ...payload }`，展开把生成的 id 盖掉，
    // 于是 pending 表登记 `r1`、回包带 `dl-…`，两边永远对不上 —— 权重明明下完了
    // （进度都报到 done），调用方却一直等到 60 分钟超时，界面上就是"下载卡住"。
    const frame = JSON.parse(workerFrame("r1", { msg: "download", weights: "acme/x", id: "dl-acme/x" }));
    expect(frame.id).toBe("r1");
    expect(frame.msg).toBe("download");
    expect(frame.weights).toBe("acme/x");
  });

  test("帧是一整行（协议按行切分，中间不能有换行）", () => {
    const line = workerFrame("r2", { msg: "predict", state: "a\nb" });
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trimEnd().includes("\n")).toBe(false);
  });
});
