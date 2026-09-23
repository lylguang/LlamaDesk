/**
 * 音乐歌单的数据层：左侧歌单栏、歌单内的曲目顺序、"新作自动进默认歌单"。
 *
 * 三个决定值得先说明，否则后面读代码会觉得别扭：
 *
 * 1. **默认歌单是库里的真实一行**（`builtin = 1`），不是前端过滤出来的虚拟集合。
 *    这样"从默认歌单里移掉一首歌"才有地方落笔 —— 否则移掉之后它又会被"所有未归属的歌"
 *    这条规则重新捞回来，用户会看到删除按钮点了没用。
 * 2. **老库的补齐只发生在默认歌单被创建的那一刻**（`ensureDefaultPlaylist`，与建行同事务）。
 *    这个功能上线前生成的作品因此一次性进入默认歌单；此后再也不会自动回填，
 *    用户的手工增删才能长期成立。
 * 3. **默认歌单按"新歌在前"排**（position 递减），用户自建歌单按"加入顺序"排（递增）。
 *    默认歌单实际是"我的音乐库"，刚生成完的歌应该在第一眼看到；自建歌单是手编的合集，
 *    追加到末尾才符合预期。
 *
 * 本模块只认识歌单两张表 + `music_records` 的只读投影（封面种子与存在性校验），
 * 不 import `music-gen.ts` —— 依赖是单向的：`music-gen` → 这里（新作收录、删作清理）。
 * 曲目的完整行由 RPC 层拼装（`listMusicPlaylistRecordIds` + `getMusicRecordsByIds`）。
 */
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "./db";
import { musicPlaylistItems, musicPlaylists, musicRecords } from "./db/schema";
import { chatImageUrl } from "../shared/server-info";
import { logEvent } from "./app-log";

// ---------------------------------------------------------------------------
// 限额（RPC 与控制通道的输入都不可信，边界在这里再夹一遍）
// ---------------------------------------------------------------------------

export const PLAYLIST_LIMITS = {
  /** 歌单名长度（按字符计，中文歌单名 40 个字足够）。 */
  name: 40,
  /** 歌单数量上限：左侧栏是给人看的，再多也失去意义。 */
  playlists: 200,
  /** 单次批量加歌上限。 */
  addBatch: 500,
  /** 单次查询成员关系（"加入歌单"菜单里的勾选状态）的记录数上限。 */
  queryBatch: 200,
} as const;

/** 默认歌单在库里的名字。界面上显示的是 i18n 词条（`builtin` 为真时），这里只是给 CLI / 日志看。 */
export const DEFAULT_PLAYLIST_NAME = "默认歌单";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 左侧歌单栏的一行：数量与封面种子都在这一层算好，前端不再逐条查。 */
export type MusicPlaylistSummary = {
  id: number;
  name: string;
  /** 内置的默认歌单：界面用本地化名字显示，且不给改名 / 删除。 */
  builtin: boolean;
  /** 歌单里的曲目数（含生成中与失败的，它们也是"在歌单里"）。 */
  count: number;
  /**
   * 封面拼图用的前四首（id + 歌名 + 封面地址）。`coverUrl` 为空时前端按歌名生成
   * 确定性渐变兜底 —— 有真封面的先显示真封面。
   */
  coverSeeds: { id: number; title: string; coverUrl: string | null }[];
  createdAt: number;
  updatedAt: number;
};

export type PlaylistWriteResult = { ok: boolean; error?: string };

/** 建歌单的回执带上新行本身：前端建完要立刻切过去，不该再拉一次列表猜哪个是新的。 */
export type CreatePlaylistResult = PlaylistWriteResult & { playlist?: MusicPlaylistSummary };

// ---------------------------------------------------------------------------
// 输入归一化
// ---------------------------------------------------------------------------

/**
 * 歌单名归一化：去首尾空白、内部换行折成空格、限长。空名返回 null（调用方据此拒绝）。
 * 只做形状校验，不做"重复名"判断 —— 两个同名歌单是允许的，用户自己分得清。
 */
export function normalizePlaylistName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/\s+/g, " ").trim().slice(0, PLAYLIST_LIMITS.name);
  return name.length > 0 ? name : null;
}

/** 记录 id 数组归一化：只留正整数、去重、限个数。 */
function normalizeRecordIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const v of raw) {
    const id = typeof v === "number" ? v : Number(v);
    if (!Number.isInteger(id) || id <= 0) continue;
    if (!out.includes(id)) out.push(id);
    if (out.length >= PLAYLIST_LIMITS.addBatch) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 默认歌单
// ---------------------------------------------------------------------------

/** 默认歌单的 id（不存在就建，并把已有的作品一次性补齐进去）。 */
export function ensureDefaultPlaylist(): number {
  const [existing] = db
    .select({ id: musicPlaylists.id })
    .from(musicPlaylists)
    .where(eq(musicPlaylists.builtin, 1))
    .orderBy(asc(musicPlaylists.id))
    .limit(1)
    .all();
  if (existing) return existing.id;

  return db.transaction((tx) => {
    const row = tx
      .insert(musicPlaylists)
      .values({ name: DEFAULT_PLAYLIST_NAME, builtin: 1 })
      .returning()
      .get();
    // 一次性补齐：这个功能上线前生成的作品按 id 顺序进默认歌单（新歌在前，见文件头）。
    const ids = tx
      .select({ id: musicRecords.id })
      .from(musicRecords)
      .orderBy(desc(musicRecords.id))
      .all();
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      tx.insert(musicPlaylistItems)
        .values(chunk.map((r, j) => ({ playlistId: row.id, recordId: r.id, position: i + j })))
        .onConflictDoNothing()
        .run();
    }
    return row.id;
  });
}

/**
 * 新作品收录进默认歌单（生成任务落库时调用）。
 *
 * **失败不抛**：记录已经写进 `music_records` 了，把提交接口连坐搞崩只会让用户以为生成失败 ——
 * 一首歌没进歌单是可以补的（重新生成时还会再试），一次生成失败不是。
 */
export function addToDefaultPlaylist(recordId: number): void {
  try {
    const playlistId = ensureDefaultPlaylist();
    const position = headPosition(playlistId);
    db.insert(musicPlaylistItems)
      .values({ playlistId, recordId, position })
      .onConflictDoNothing()
      .run();
    touchPlaylist(playlistId);
  } catch (e) {
    logEvent({
      level: "warn",
      source: "music",
      event: "music.playlist.default_add_failed",
      message: `作品 ${recordId} 未能自动进默认歌单`,
      detail: { recordId, error: e },
    });
  }
}

/** 删作品时清掉它在所有歌单里的成员关系（`music_records` 那一行由 music-gen 删）。 */
export function removeRecordFromAllPlaylists(recordId: number): void {
  db.delete(musicPlaylistItems).where(eq(musicPlaylistItems.recordId, recordId)).run();
}

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

/**
 * 左侧歌单栏：默认歌单永远排最前，其余按最后加歌时间倒序。
 *
 * 读之前先 `ensureDefaultPlaylist()`（与云厂商目录的 `ensureBuiltinProviders` 同一个套路）：
 * 侧栏是"默认歌单"唯一的入口，缺了它用户会以为没有这个歌单；
 * 首次读取顺带把老作品补齐，之后不再回填。
 */
export function listMusicPlaylists(): MusicPlaylistSummary[] {
  ensureDefaultPlaylist();
  const rows = db
    .select()
    .from(musicPlaylists)
    .orderBy(desc(musicPlaylists.builtin), desc(musicPlaylists.updatedAt), desc(musicPlaylists.id))
    .limit(PLAYLIST_LIMITS.playlists)
    .all();
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const counted = db
    .select({ playlistId: musicPlaylistItems.playlistId, n: count() })
    .from(musicPlaylistItems)
    .where(inArray(musicPlaylistItems.playlistId, ids))
    .groupBy(musicPlaylistItems.playlistId)
    .all();
  const countMap = new Map(counted.map((c) => [c.playlistId, c.n]));

  // 封面种子：每个歌单按 position 取前四首。窗口函数在一条查询里做完分组取前 N，
  // 免得"200 个歌单 × 每单一次查询"或把全部成员关系拉回来内存里分组。
  const coverRows = db.all<{
    playlist_id: number;
    record_id: number;
    title: string | null;
    cover_path: string | null;
  }>(sql`
    SELECT playlist_id, record_id, title, cover_path FROM (
      SELECT i.playlist_id AS playlist_id,
             i.record_id AS record_id,
             r.title AS title,
             r.cover_path AS cover_path,
             row_number() OVER (PARTITION BY i.playlist_id ORDER BY i.position, i.id) AS rn
      FROM music_playlist_items i
      LEFT JOIN music_records r ON r.id = i.record_id
      WHERE i.playlist_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
    ) WHERE rn <= 4
  `);
  const coverMap = new Map<number, { id: number; title: string; coverUrl: string | null }[]>();
  for (const c of coverRows) {
    const list = coverMap.get(c.playlist_id) ?? [];
    list.push({
      id: c.record_id,
      title: c.title ?? "",
      coverUrl: c.cover_path ? chatImageUrl(c.cover_path) : null,
    });
    coverMap.set(c.playlist_id, list);
  }

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    builtin: r.builtin === 1,
    count: countMap.get(r.id) ?? 0,
    coverSeeds: coverMap.get(r.id) ?? [],
    createdAt: r.createdAt ?? 0,
    updatedAt: r.updatedAt ?? 0,
  }));
}

/** 歌单曲目 id（按歌单内顺序）。完整记录行由 RPC 层补上。 */
export function listMusicPlaylistRecordIds(playlistId: number): number[] {
  return db
    .select({ recordId: musicPlaylistItems.recordId })
    .from(musicPlaylistItems)
    .where(eq(musicPlaylistItems.playlistId, playlistId))
    .orderBy(asc(musicPlaylistItems.position), asc(musicPlaylistItems.id))
    .all()
    .map((r) => r.recordId);
}

/** "加入歌单"菜单的勾选状态：每首作品当前在哪些歌单里。 */
export function playlistIdsForRecords(rawIds: unknown): Record<number, number[]> {
  const ids = normalizeRecordIds(rawIds).slice(0, PLAYLIST_LIMITS.queryBatch);
  const out: Record<number, number[]> = {};
  if (ids.length === 0) return out;
  const rows = db
    .select({ recordId: musicPlaylistItems.recordId, playlistId: musicPlaylistItems.playlistId })
    .from(musicPlaylistItems)
    .where(inArray(musicPlaylistItems.recordId, ids))
    .all();
  for (const r of rows) {
    (out[r.recordId] ??= []).push(r.playlistId);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 写
// ---------------------------------------------------------------------------

export function createMusicPlaylist(rawName: unknown): CreatePlaylistResult {
  const name = normalizePlaylistName(rawName);
  if (!name) return { ok: false, error: "歌单名不能为空" };
  const [row] = db.select({ n: count() }).from(musicPlaylists).all();
  if ((row?.n ?? 0) >= PLAYLIST_LIMITS.playlists) {
    return { ok: false, error: `歌单数量已达上限（${PLAYLIST_LIMITS.playlists} 个）` };
  }
  const created = db.insert(musicPlaylists).values({ name }).returning().get();
  const [summary] = listMusicPlaylists().filter((p) => p.id === created.id);
  return { ok: true, playlist: summary };
}

export function renameMusicPlaylist(id: number, rawName: unknown): PlaylistWriteResult {
  const name = normalizePlaylistName(rawName);
  if (!name) return { ok: false, error: "歌单名不能为空" };
  const target = findPlaylist(id);
  if (!target) return { ok: false, error: `歌单不存在（id ${id}）` };
  // 默认歌单的名字是界面词条的一部分（"默认歌单"这四个字要跟着语言变），改掉就两头不一致。
  if (target.builtin === 1) return { ok: false, error: "默认歌单不能改名" };
  db.update(musicPlaylists).set({ name }).where(eq(musicPlaylists.id, id)).run();
  return { ok: true };
}

export function deleteMusicPlaylist(id: number): PlaylistWriteResult {
  const target = findPlaylist(id);
  if (!target) return { ok: false, error: `歌单不存在（id ${id}）` };
  // 默认歌单删掉，下一首新歌又会把它建回来 —— 与其让人以为删干净了，不如直接拒绝。
  if (target.builtin === 1) return { ok: false, error: "默认歌单不能删除" };
  db.transaction((tx) => {
    tx.delete(musicPlaylistItems).where(eq(musicPlaylistItems.playlistId, id)).run();
    tx.delete(musicPlaylists).where(eq(musicPlaylists.id, id)).run();
  });
  return { ok: true };
}

/**
 * 加入歌单。已存在的不重复加（幂等），不存在的作品 id 直接丢掉 ——
 * 前端可能正拿着一条刚被删掉的记录。
 */
export function addMusicToPlaylist(
  playlistId: number,
  rawRecordIds: unknown,
): PlaylistWriteResult & { added?: number } {
  const target = findPlaylist(playlistId);
  if (!target) return { ok: false, error: `歌单不存在（id ${playlistId}）` };
  const ids = normalizeRecordIds(rawRecordIds);
  if (ids.length === 0) return { ok: true, added: 0 };

  const alive = db
    .select({ id: musicRecords.id })
    .from(musicRecords)
    .where(inArray(musicRecords.id, ids))
    .all()
    .map((r) => r.id);
  const present = new Set(
    db
      .select({ recordId: musicPlaylistItems.recordId })
      .from(musicPlaylistItems)
      .where(
        and(
          eq(musicPlaylistItems.playlistId, playlistId),
          inArray(musicPlaylistItems.recordId, alive.length ? alive : [-1]),
        ),
      )
      .all()
      .map((r) => r.recordId),
  );
  const fresh = alive.filter((id) => !present.has(id));
  if (fresh.length === 0) return { ok: true, added: 0 };

  // 追加到末尾：自建歌单是手编的顺序，新加的应该排在后面（默认歌单才走 headPosition）。
  const base = tailPosition(playlistId);
  const sorted = tailOrder(fresh);
  db.insert(musicPlaylistItems)
    .values(sorted.map((recordId, i) => ({ playlistId, recordId, position: base + i })))
    .onConflictDoNothing()
    .run();
  touchPlaylist(playlistId);
  return { ok: true, added: fresh.length };
}

/** 从歌单里移出一首。默认歌单也允许 —— 移掉就是移掉，不会被回填逻辑捞回来。 */
export function removeMusicFromPlaylist(playlistId: number, recordId: number): PlaylistWriteResult {
  const target = findPlaylist(playlistId);
  if (!target) return { ok: false, error: `歌单不存在（id ${playlistId}）` };
  db.delete(musicPlaylistItems)
    .where(
      and(eq(musicPlaylistItems.playlistId, playlistId), eq(musicPlaylistItems.recordId, recordId)),
    )
    .run();
  touchPlaylist(playlistId);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

function findPlaylist(id: number): { id: number; builtin: number } | undefined {
  if (!Number.isInteger(id) || id <= 0) return undefined;
  return db
    .select({ id: musicPlaylists.id, builtin: musicPlaylists.builtin })
    .from(musicPlaylists)
    .where(eq(musicPlaylists.id, id))
    .limit(1)
    .all()[0];
}

/** 追加位置：末尾 + 1。 */
function tailPosition(playlistId: number): number {
  const [row] = db
    .select({ max: sql<number | null>`max(${musicPlaylistItems.position})` })
    .from(musicPlaylistItems)
    .where(eq(musicPlaylistItems.playlistId, playlistId))
    .all();
  return (row?.max ?? -1) + 1;
}

/** 头插位置：最前 - 1（默认歌单用；空歌单从 0 起）。 */
function headPosition(playlistId: number): number {
  const [row] = db
    .select({ min: sql<number | null>`min(${musicPlaylistItems.position})` })
    .from(musicPlaylistItems)
    .where(eq(musicPlaylistItems.playlistId, playlistId))
    .all();
  return row?.min == null ? 0 : row.min - 1;
}

/** 批量加歌时按 id 升序落位：用户勾选的顺序没有意义，稳定顺序才不会每次排得不一样。 */
function tailOrder(ids: number[]): number[] {
  return [...ids].sort((a, b) => a - b);
}

function touchPlaylist(playlistId: number): void {
  db.update(musicPlaylists)
    .set({ updatedAt: Date.now() })
    .where(eq(musicPlaylists.id, playlistId))
    .run();
}
