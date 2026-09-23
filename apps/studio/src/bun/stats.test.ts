import { describe, expect, test } from "bun:test";

import { servedInstanceStats, type ServedInstanceStat } from "./stats";
import type { ServedModelInfo } from "../shared/served-models";

/** 只填断言要用到的字段，其余按类型给个合理的默认值。 */
function served(patch: Partial<ServedModelInfo> & { id: string }): ServedModelInfo {
  return {
    modelRef: `/models/${patch.id}.gguf`,
    label: patch.id,
    engine: "llama.cpp",
    port: 18400,
    endpoint: "http://127.0.0.1:18400/v1",
    servedName: patch.id,
    purpose: "chat",
    status: "running",
    usesDefaultPort: true,
    isActive: false,
    isDir: false,
    ...patch,
  };
}

const byId = (rows: ServedInstanceStat[]) => new Map(rows.map((r) => [r.id, r]));

describe("servedInstanceStats", () => {
  test("逐进程显存按 pid 归属：这是 OPS-05「逐模型显存」的唯一实测来源", () => {
    const rows = byId(
      servedInstanceStats(
        [served({ id: "a", pid: 4711 }), served({ id: "b", pid: 4712 })],
        new Map([
          [4711, 4_000],
          [4712, 9_000],
        ]),
      ),
    );
    expect(rows.get("a")!.vramBytes).toBe(4_000);
    expect(rows.get("b")!.vramBytes).toBe(9_000);
  });

  test("读不到就是 null，不拿别人的数顶上（界面显示「—」而不是猜）", () => {
    const rows = byId(
      servedInstanceStats(
        // 没有 pid 的实例（还没起来）与 pid 不在 nvidia-smi 列表里的实例
        [served({ id: "no-pid" }), served({ id: "not-listed", pid: 999 })],
        new Map([[4711, 4_000]]),
      ),
    );
    expect(rows.get("no-pid")!.vramBytes).toBeNull();
    expect(rows.get("no-pid")!.pid).toBeNull();
    expect(rows.get("not-listed")!.vramBytes).toBeNull();
  });

  test("权重体积照抄扫描结果（哪个平台都有，与显存实测无关）", () => {
    const rows = servedInstanceStats([served({ id: "a", sizeBytes: 5_000_000_000 })], new Map());
    expect(rows[0]!.weightsBytes).toBe(5_000_000_000);
    expect(servedInstanceStats([served({ id: "b" })], new Map())[0]!.weightsBytes).toBeNull();
  });

  test("已停止的实例不进列表：它不占任何资源，列出来只会让人以为还在跑", () => {
    const rows = servedInstanceStats(
      [served({ id: "running" }), served({ id: "stopped", status: "stopped" })],
      new Map(),
    );
    expect(rows.map((r) => r.id)).toEqual(["running"]);
  });

  test("启动中 / 下载中也算「运行中的一个实例」（此刻正在占磁盘或正在加载）", () => {
    const rows = servedInstanceStats(
      [
        served({ id: "starting", status: "starting" }),
        served({ id: "downloading", status: "downloading" }),
      ],
      new Map(),
    );
    expect(rows.map((r) => r.id)).toEqual(["starting", "downloading"]);
  });
});
