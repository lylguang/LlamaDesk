/**
 * 音乐歌单（bun/music-playlists.ts）的行为。
 *
 * 这里钉的都是"错一次就会让用户觉得歌单坏了"的点：
 *  - 默认歌单只建一次、不能被改名 / 删除；
 *  - 老作品只在默认歌单创建时补一次，之后移出去的作品**不会**被回填捞回来；
 *  - 加入歌单幂等、悬空 id（记录已被删）直接丢掉；
 *  - 删作品会把它的成员关系一起带走，歌单里不会留下指不到作品的位置。
 *
 * 与 video-gen.test.ts 同样的做法：独立临时库 + 跑真实迁移，验证的是真 SQL。
 */
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { join } from "path";
import * as fs from "fs";

import * as schema from "./db/schema";
import { mockModulePartial } from "./test-mocks";

const tmpDb = `/tmp/music-playlists-test-${process.pid}.db`;
fs.rmSync(tmpDb, { force: true });
const sqlite = new Database(tmpDb, { create: true });
const db = drizzle({ client: sqlite, schema });
migrate(db, { migrationsFolder: join(import.meta.dir, "db/migrations") });

await mockModulePartial<typeof import("./db")>("./db", { db });

const {
  DEFAULT_PLAYLIST_NAME,
  PLAYLIST_LIMITS,
  addMusicToPlaylist,
  addToDefaultPlaylist,
  createMusicPlaylist,
  deleteMusicPlaylist,
  ensureDefaultPlaylist,
  listMusicPlaylistRecordIds,
  listMusicPlaylists,
  normalizePlaylistName,
  playlistIdsForRecords,
  removeMusicFromPlaylist,
  renameMusicPlaylist,
} = await import("./music-playlists");

afterAll(() => {
  sqlite.close();
  fs.rmSync(tmpDb, { force: true });
});

let nextRecordId = 1;
/** 直接往 music_records 塞一条最小记录：这个模块只关心 id 与歌名。 */
function seedRecord(title: string): number {
  const id = nextRecordId++;
  db.insert(schema.musicRecords).values({ id, title, status: "done" }).run();
  return id;
}

const defaultId = ensureDefaultPlaylist();

test("默认歌单：名字、内置标记、只建一次", () => {
  const again = ensureDefaultPlaylist();
  expect(again).toBe(defaultId);
  const rows = db.select().from(schema.musicPlaylists).all();
  expect(rows.filter((r) => r.builtin === 1).length).toBe(1);
  expect(rows.find((r) => r.id === defaultId)?.name).toBe(DEFAULT_PLAYLIST_NAME);
});

test("歌单名：去空白、折换行、限长，空名不成立", () => {
  expect(normalizePlaylistName("  深夜  City  Pop ")).toBe("深夜 City Pop");
  expect(normalizePlaylistName("第一行\n第二行")).toBe("第一行 第二行");
  expect(normalizePlaylistName("")).toBeNull();
  expect(normalizePlaylistName("   ")).toBeNull();
  expect(normalizePlaylistName(42)).toBeNull();
  expect(normalizePlaylistName("x".repeat(120))!.length).toBe(PLAYLIST_LIMITS.name);
});

test("新作品自动进默认歌单，且排在前面（重排后 id 顺序不乱）", () => {
  const a = seedRecord("第一首");
  const b = seedRecord("第二首");
  addToDefaultPlaylist(a);
  addToDefaultPlaylist(b);
  // 新歌在前：第二首在第一个位置。
  expect(listMusicPlaylistRecordIds(defaultId).slice(0, 2)).toEqual([b, a]);
});

test("加入歌单幂等：同一首加两次只留一条，悬空 id 直接丢掉", () => {
  const created = createMusicPlaylist("手编合集");
  expect(created.ok).toBe(true);
  const playlistId = created.playlist!.id;
  const id = seedRecord("重复加");
  expect(addMusicToPlaylist(playlistId, [id, id]).added).toBe(1);
  expect(addMusicToPlaylist(playlistId, [id]).added).toBe(0);
  // 999999 不存在：不报错、也不落成员关系。
  expect(addMusicToPlaylist(playlistId, [id, 999999]).added).toBe(0);
  expect(listMusicPlaylistRecordIds(playlistId)).toEqual([id]);
  // 自建歌单按加入顺序追加：再塞一首排在后面。
  const second = seedRecord("第二波");
  addMusicToPlaylist(playlistId, [second]);
  expect(listMusicPlaylistRecordIds(playlistId)).toEqual([id, second]);
});

test("移出歌单：对默认歌单同样成立，且不会被再次回填", () => {
  const id = seedRecord("会被移出的");
  addToDefaultPlaylist(id);
  expect(listMusicPlaylistRecordIds(defaultId)).toContain(id);
  expect(removeMusicFromPlaylist(defaultId, id).ok).toBe(true);
  expect(listMusicPlaylistRecordIds(defaultId)).not.toContain(id);
  // 再读一次列表（内部会调 ensureDefaultPlaylist）：不能又被塞回来。
  listMusicPlaylists();
  expect(listMusicPlaylistRecordIds(defaultId)).not.toContain(id);
});

test("默认歌单不能改名 / 删除，自建歌单可以", () => {
  expect(renameMusicPlaylist(defaultId, "换个名字").ok).toBe(false);
  expect(deleteMusicPlaylist(defaultId).ok).toBe(false);

  const created = createMusicPlaylist("待改名");
  const id = created.playlist!.id;
  expect(renameMusicPlaylist(id, "改过了").ok).toBe(true);
  expect(listMusicPlaylists().find((p) => p.id === id)?.name).toBe("改过了");
  const kept = seedRecord("留着");
  addMusicToPlaylist(id, [kept]);
  expect(deleteMusicPlaylist(id).ok).toBe(true);
  // 删歌单不碰作品本身，只删成员关系。
  expect(listMusicPlaylists().some((p) => p.id === id)).toBe(false);
  expect(
    db.select().from(schema.musicRecords).where(eq(schema.musicRecords.id, kept)).all().length,
  ).toBe(1);
  expect(listMusicPlaylistRecordIds(id)).toEqual([]);
});

test("不存在的歌单：改名 / 删除 / 加歌都拒绝，而不是静默成功", () => {
  expect(renameMusicPlaylist(987654, "x").ok).toBe(false);
  expect(deleteMusicPlaylist(987654).ok).toBe(false);
  expect(addMusicToPlaylist(987654, [1]).ok).toBe(false);
  expect(removeMusicFromPlaylist(987654, 1).ok).toBe(false);
});

test("列表摘要：默认歌单排最前，数量与封面种子都对得上", () => {
  const summaries = listMusicPlaylists();
  expect(summaries[0]!.id).toBe(defaultId);
  expect(summaries[0]!.builtin).toBe(true);
  const target = summaries[0]!;
  expect(target.count).toBe(listMusicPlaylistRecordIds(defaultId).length);
  expect(target.coverSeeds.length).toBe(Math.min(4, target.count));
});

test("成员关系查询：返回每首作品分别在哪些歌单里", () => {
  const created = createMusicPlaylist("勾选状态");
  const playlistId = created.playlist!.id;
  const id = seedRecord("两边都在");
  addToDefaultPlaylist(id);
  addMusicToPlaylist(playlistId, [id]);
  const map = playlistIdsForRecords([id]);
  expect(new Set(map[id])).toEqual(new Set([defaultId, playlistId]));
  expect(playlistIdsForRecords("not-an-array")).toEqual({});
});

test("删作品时成员关系一起走（由 music-gen 调用，这里只验证函数本身）", async () => {
  const { removeRecordFromAllPlaylists } = await import("./music-playlists");
  const id = seedRecord("即将被删");
  const created = createMusicPlaylist("删作品");
  const playlistId = created.playlist!.id;
  addToDefaultPlaylist(id);
  addMusicToPlaylist(playlistId, [id]);
  removeRecordFromAllPlaylists(id);
  expect(listMusicPlaylistRecordIds(defaultId)).not.toContain(id);
  expect(listMusicPlaylistRecordIds(playlistId)).not.toContain(id);
});
