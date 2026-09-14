import { afterAll, expect, mock, test } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// 媒体服务端口是固定的，而 dev / canary / 正式版各有一份数据目录：两个实例同时开着时，
// 后来的那个过去只是把 EADDRINUSE 吞掉，整个会话没有媒体服务（生成的音频点预览就说
// "文件不存在"）。这个文件专门盯住这段逻辑：探身份、报状态、并在对方退出后自动接管。
process.env.OMNI_IMAGE_SERVER_PORT = "19798";
const originalHome = process.env.HOME;
process.env.HOME = mkdtempSync(join(tmpdir(), "omni-media-conflict-"));
mock.module("electrobun/bun", () => ({
  Utils: { paths: { userData: join(process.env.HOME!, "Library", "OmniStudio") } },
}));

const { startImageServer, getMediaServerStatus, mediaServerId } = await import("./image-server");
const { imageServerPort } = await import("../shared/server-info");
const { readAppLogsInMemory } = await import("./app-log");

const PORT = imageServerPort();

/** 假装端口上的占用者：可以给出一个"别人的"身份，也可以什么都不给（旧版本 / 不相干的软件）。 */
let holderId: string | null = "ffffffffffff";
const holder = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  fetch(req) {
    if (new URL(req.url).pathname === "/__omni/media-id") {
      return holderId
        ? Response.json({ id: holderId, pid: 1234 })
        : new Response("Not found", { status: 404 });
    }
    return new Response("Not found", { status: 404 });
  },
});

const RETRY_MS = 60;
const waitFor = async (predicate: () => boolean, ms = 2_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(10);
  }
  return predicate();
};

afterAll(() => {
  holder.stop(true);
  // HOME 是进程级的，同一个测试进程里后面的文件还要用（homedir() 读的就是它）。
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  // "同一份数据目录"那条用例会留下一个仍在重试的定时器（真实行为：等对方退出后接管），
  // 而 bun 的测试是同进程串行跑多个文件、且端口是按 env 现读的——它下一轮就可能去绑别的
  // 测试文件的端口。指到一个非 root 绑不上的端口上，让它永远失败得毫无副作用。
  process.env.OMNI_IMAGE_SERVER_PORT = "1";
});

test("占用者是另一个数据目录的实例：报 blocked，并带上占用者身份", async () => {
  startImageServer({ retryMs: RETRY_MS });
  // 探测是异步的（要问一句端口上是谁），状态由初始值被改写才算探明。
  expect(await waitFor(() => getMediaServerStatus().otherInstance === true)).toBe(true);

  const status = getMediaServerStatus();
  expect(status.state).toBe("blocked");
  expect(status.holderPid).toBe(1234);
});

test("占用者认不出身份（旧版本 / 别的软件）：也绝不当作自己人", async () => {
  holderId = null;
  startImageServer({ retryMs: RETRY_MS });
  expect(await waitFor(() => getMediaServerStatus().otherInstance === false)).toBe(true);

  const status = getMediaServerStatus();
  expect(status.state).toBe("blocked");
  expect(status.otherInstance).toBe(false);
  expect(status.holderPid).toBeUndefined();
});

test("占用者退出后自动接管端口，不用重启应用", async () => {
  holder.stop(true);
  expect(await waitFor(() => getMediaServerStatus().state === "serving")).toBe(true);

  // 接管是真的：端口上现在应答身份的应该是本进程。
  const res = await fetch(`http://127.0.0.1:${PORT}/__omni/media-id`);
  expect(await res.json()).toEqual({ id: mediaServerId(), pid: process.pid });
});

test("端口被同一份数据目录的实例占着（同频道开了两个）：算 shared，效果等同于正常", async () => {
  // 本进程已经占着端口，再启动一次就是在模拟"同数据的第二个实例"。
  startImageServer({ retryMs: RETRY_MS });
  expect(await waitFor(() => getMediaServerStatus().state === "shared")).toBe(true);
});

test("三种状态都写进统一日志：blocked / shared 是「预览全挂」的唯一线索", async () => {
  const entries = readAppLogsInMemory({ source: "media-server" });
  const events = entries.map((e) => e.event);
  expect(events).toContain("media.server.blocked");
  expect(events).toContain("media.server.shared");
  expect(events).toContain("media.server.serving");

  const blocked = entries.filter((e) => e.event === "media.server.blocked");
  expect(blocked.every((e) => e.level === "error")).toBe(true);
  // 认得出身份的（另一个实例）与认不出的（旧版本 / 不相干的软件）都要留下占用者信息。
  const holderPids = blocked.map(
    (e) => (e.detail as { holderPid?: number | null } | undefined)?.holderPid,
  );
  expect(holderPids).toContain(1234);
  expect(holderPids).toContain(null);
});
