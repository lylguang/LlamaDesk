/**
 * 受管子进程登记册（child-registry）测试。
 *
 * 不真的杀进程：把「读 cmdline」和「发信号」两件事做成可注入的（reapRecordedChildren
 * 的 opts），测试注入假的。数据目录由 test-preload.ts 指向临时目录（OMNI_DATA_DIR），
 * 所以落盘文件不会碰到真实用户数据。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "fs";

import {
  __childRegistryFileForTest as registryFile,
  forgetChild,
  listRecordedChildren,
  reapRecordedChildren,
  recordChild,
  type ChildRecord,
  type ReapOptions,
} from "./child-registry";

/** 假的「核对身份 + 发信号」依赖，reapRecordedChildren 的 opts 用。 */
type ReapFakes = ReapOptions & {
  /** 按调用次序返回的 cmdline 序列；null = 进程不存在。 */
  cmdlines: Array<string | null>;
  /** 记录被发到的 (pgid, signal)。 */
  signals: Array<{ pgid: number; signal: "SIGTERM" | "SIGKILL" }>;
};

function makeFakes(cmdlines: Array<string | null>): ReapFakes {
  const signals: Array<{ pgid: number; signal: "SIGTERM" | "SIGKILL" }> = [];
  let i = 0;
  return {
    cmdlines,
    signals,
    readCmdline: () => cmdlines[Math.min(i++, cmdlines.length - 1)] ?? null,
    signalGroup: (pgid, signal) => {
      signals.push({ pgid, signal });
    },
    sleep: () => Promise.resolve(),
  };
}

function rec(over: Partial<ChildRecord> = {}): ChildRecord {
  return {
    pid: 12345,
    pgid: 12345,
    exe: "/opt/engines/llama-server",
    startedAt: Date.now(),
    owner: "llama.cpp",
    ...over,
  };
}

beforeEach(() => {
  try {
    rmSync(registryFile(), { force: true });
  } catch {
    // ignore
  }
});

afterEach(() => {
  try {
    rmSync(registryFile(), { force: true });
  } catch {
    // ignore
  }
});

describe("child-registry 落盘", () => {
  test("记录 → 读回 → 遗忘", () => {
    const r = rec();
    recordChild(r);
    expect(listRecordedChildren()).toEqual([r]);

    forgetChild(r.pid);
    expect(listRecordedChildren()).toEqual([]);
  });

  test("重复记录同一 pid 只留一条（后写覆盖）", () => {
    recordChild(rec({ owner: "first" }));
    recordChild(rec({ owner: "second" }));
    const list = listRecordedChildren();
    expect(list).toHaveLength(1);
    expect(list[0]?.owner).toBe("second");
  });

  test("落盘文件内容正确（magic + children）", () => {
    const r = rec();
    recordChild(r);
    const raw = JSON.parse(readFileSync(registryFile(), "utf8")) as {
      magic: string;
      children: ChildRecord[];
    };
    expect(raw.magic).toBe("omni-studio-child-pids-v1");
    expect(raw.children).toEqual([r]);
  });
});

describe("child-registry 容错", () => {
  test("文件损坏（非法 JSON）→ 空数组，不抛", () => {
    writeFileSync(registryFile(), "{ not json !!!", "utf8");
    expect(listRecordedChildren()).toEqual([]);
  });

  test("schema 不符（magic 不对）→ 空数组，不抛", () => {
    writeFileSync(
      registryFile(),
      JSON.stringify({ magic: "wrong", children: [rec()] }),
      "utf8",
    );
    expect(listRecordedChildren()).toEqual([]);
  });

  test("children 里混入坏条目只丢掉坏条目", () => {
    const good = rec();
    writeFileSync(
      registryFile(),
      JSON.stringify({
        magic: "omni-studio-child-pids-v1",
        children: [good, { pid: "not-a-number", pgid: 1, exe: "x", startedAt: 1, owner: "y" }],
      }),
      "utf8",
    );
    expect(listRecordedChildren()).toEqual([good]);
  });
});

describe("reapRecordedChildren 身份核对", () => {
  test("核对不通过（cmdline 是别的程序）→ 不 kill，记录被清", async () => {
    const r = rec();
    recordChild(r);
    const fakes = makeFakes(["/usr/bin/some-other-user-app"]);

    const reaped = await reapRecordedChildren(fakes);

    expect(reaped).toBe(0);
    expect(fakes.signals).toEqual([]); // 绝不误杀
    expect(listRecordedChildren()).toEqual([]); // 记录被清掉
  });

  test("核对通过 → SIGTERM 整个进程组，记录被清", async () => {
    const r = rec({ pid: 4242, pgid: 4242 });
    recordChild(r);
    // 第一次读：核对身份（llama-server）；SIGTERM 后的第二次读：已死（null）。
    const fakes = makeFakes(["/opt/engines/llama-server", null]);

    const reaped = await reapRecordedChildren(fakes);

    expect(reaped).toBe(1);
    expect(fakes.signals).toEqual([{ pgid: 4242, signal: "SIGTERM" }]);
    expect(listRecordedChildren()).toEqual([]);
  });

  test("核对通过且 SIGTERM 后还活着 → 补 SIGKILL", async () => {
    const r = rec({ pid: 88, pgid: 88 });
    recordChild(r);
    // 两次读都返回 llama-server（一直活着），验证会补 SIGKILL。
    const fakes = makeFakes(["/opt/engines/llama-server", "/opt/engines/llama-server"]);

    const reaped = await reapRecordedChildren(fakes);

    expect(reaped).toBe(1);
    expect(fakes.signals).toEqual([
      { pgid: 88, signal: "SIGTERM" },
      { pgid: 88, signal: "SIGKILL" },
    ]);
    expect(listRecordedChildren()).toEqual([]);
  });

  test("进程已不存在（cmdline 读不到）→ 不 kill，记录被清", async () => {
    const r = rec();
    recordChild(r);
    const fakes = makeFakes([null]);

    const reaped = await reapRecordedChildren(fakes);

    expect(reaped).toBe(0);
    expect(fakes.signals).toEqual([]);
    expect(listRecordedChildren()).toEqual([]);
  });

  test("多条记录各自独立处理", async () => {
    recordChild(rec({ pid: 1, pgid: 1 })); // 还活着
    recordChild(rec({ pid: 2, pgid: 2 })); // 已死
    recordChild(rec({ pid: 3, pgid: 3 })); // 身份不符
    // 按 pid 区分：pid1 一直活（llama-server），pid2 死（null），pid3 换成别的程序。
    const signals: Array<{ pgid: number; signal: string }> = [];
    const reaped = await reapRecordedChildren({
      readCmdline: (pid) => {
        if (pid === 1) return "/opt/engines/llama-server";
        if (pid === 2) return null;
        return "/usr/bin/other-app";
      },
      signalGroup: (pgid, signal) => signals.push({ pgid, signal }),
      sleep: () => Promise.resolve(),
    });

    // pid1 活着 → reaped（SIGTERM 后还活 → SIGKILL）；pid2 死 → stale；pid3 身份不符 → skipped。
    expect(reaped).toBe(1);
    expect(signals).toEqual([
      { pgid: 1, signal: "SIGTERM" },
      { pgid: 1, signal: "SIGKILL" },
    ]);
    expect(listRecordedChildren()).toEqual([]);
  });
});

describe("child-registry 并发写", () => {
  test("连续 recordChild 多次，最终文件里条目数正确（不丢）", () => {
    for (let i = 0; i < 50; i++) {
      recordChild(rec({ pid: 1000 + i, pgid: 1000 + i, owner: `e${i}` }));
    }
    expect(listRecordedChildren()).toHaveLength(50);
    const raw = JSON.parse(readFileSync(registryFile(), "utf8")) as { children: ChildRecord[] };
    expect(raw.children).toHaveLength(50);
  });

  test("record / forget 交错，最终只留活着的", () => {
    recordChild(rec({ pid: 1, pgid: 1 }));
    recordChild(rec({ pid: 2, pgid: 2 }));
    recordChild(rec({ pid: 3, pgid: 3 }));
    forgetChild(2);
    const pids = listRecordedChildren()
      .map((c) => c.pid)
      .sort();
    expect(pids).toEqual([1, 3]);
  });
});
