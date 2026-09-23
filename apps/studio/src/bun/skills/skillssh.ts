// skills.sh 市场：榜单（HTML 解析）+ 搜索（JSON API）+ 结果缓存。
import type { SkillsShSkill, SkillsLeaderboard } from "../../shared/skills";
import { getCache, setCache } from "./store";
import { logEvent } from "../app-log";

const BASE = "https://skills.sh";
const UA = "omnistudio-skills";
const TIMEOUT_MS = 15_000;
const LEADERBOARD_TTL = 5 * 60 * 1000;

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 站点跑在 Next.js App Router 上，榜单数据既不在 `__NEXT_DATA__` 里、也不是原始 HTML 里
 * 可正则直取的扁平 JSON，而是塞在 RSC 的 `self.__next_f.push([1,"…"])` 中一段**整体转义的
 * JSON 字符串**里（字段顺序是 source → skillId → name → installs）。因此必须先把 flight
 * 文本解出来再当 JSON 读 —— 对原始 HTML 打正则会一条都匹配不到，线上表现就是榜单一直
 * 「skills.sh parse empty」。chunk 是流式切开的，按出现顺序解完直接拼接即可。
 */
export function decodeRscFlight(html: string): string {
  const parts: string[] = [];
  const re = /self\.__next_f\.push\(\[1,\s*("(?:[^"\\]|\\[\s\S])*")\s*\]\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      const chunk: unknown = JSON.parse(m[1]!);
      if (typeof chunk === "string") parts.push(chunk);
    } catch {
      // 单个 chunk 解不开不影响其它 chunk。
    }
  }
  return parts.join("");
}

/** 从 `start`（`[` 处）起取配平的数组字面量，字符串内的括号不作数。 */
function sliceBalancedArray(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** 解码后的 flight 文本里取 `initialSkills` 数组（旧形状 `{ items: [...] }` 也认）。 */
function initialSkillsFromFlight(text: string): unknown[] {
  const marker = text.indexOf('"initialSkills"');
  if (marker < 0) return [];
  const head = /^"initialSkills"\s*:\s*(?:\{\s*"items"\s*:\s*)?/.exec(text.slice(marker));
  if (!head) return [];
  const at = marker + head[0].length;
  if (text[at] !== "[") return [];
  const raw = sliceBalancedArray(text, at);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** `__NEXT_DATA__`（Pages Router 时代的形态）：整段 JSON，路径与上面一致。 */
function initialSkillsFromNextData(html: string): unknown[] {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
  if (!m) return [];
  try {
    const json: any = JSON.parse(m[1] ?? "");
    const pageProps = json?.props?.pageProps;
    const items =
      pageProps?.initialSkills?.skills?.items ??
      pageProps?.skills?.items ??
      pageProps?.initialSkills?.items ??
      pageProps?.initialSkills;
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

const FIELD_RES = new Map<string, RegExp>();

/** 从一段对象字面量里取字符串字段。字面量可能来自原始 HTML（引号是 `\"`），两种都认。 */
function stringField(body: string, key: string): string | undefined {
  let re = FIELD_RES.get(key);
  if (!re) {
    re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
    FIELD_RES.set(key, re);
  }
  const m = re.exec(body);
  if (!m) return undefined;
  const raw = m[1]!;
  // 捕获组保留的是转义形态（`\\.` 不吃掉反斜杠），直接当 JSON 字符串体解开即可。
  try {
    const decoded: unknown = JSON.parse(`"${raw}"`);
    return typeof decoded === "string" ? decoded : raw;
  } catch {
    return raw;
  }
}

/**
 * 兜底：扫出「同时带 source 和 skillId」的扁平对象。字段顺序与引号转义都无所谓，
 * 站点微调 payload 形状时至少还能捞出条目，而不是整页空手而归。
 */
function scanFlatSkillObjects(text: string): unknown[] {
  const plain = text.includes('\\"') ? text.replace(/\\"/g, '"') : text;
  const out: unknown[] = [];
  const objRe = /\{[^{}]*\}/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(plain))) {
    const body = m[0];
    if (!/"skill(?:Id|_id)"/.test(body) && !/"slug"/.test(body)) continue;
    const source = stringField(body, "source") ?? stringField(body, "repo");
    const skillId =
      stringField(body, "skillId") ?? stringField(body, "skill_id") ?? stringField(body, "slug");
    if (!source || !skillId) continue;
    const installs = /"installs"\s*:\s*(\d+)/.exec(body);
    out.push({
      source,
      skillId,
      name: stringField(body, "name") ?? skillId,
      installs: installs ? Number(installs[1]) : 0,
    });
  }
  return out;
}

function normalizeAll(items: unknown[]): SkillsShSkill[] {
  const out: SkillsShSkill[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const s = normalizeSkillsshItem(it);
    if (!s || !s.source || !s.skillId || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

/** 解析 skills.sh 榜单页：内嵌 JSON（flight / __NEXT_DATA__）优先，扁平对象扫描兜底。 */
export function parseLeaderboardHtml(html: string): SkillsShSkill[] {
  const flight = decodeRscFlight(html);

  const embedded = normalizeAll([
    ...initialSkillsFromNextData(html),
    ...(flight ? initialSkillsFromFlight(flight) : []),
  ]);
  if (embedded.length > 0) return embedded;

  return normalizeAll([
    ...(flight ? scanFlatSkillObjects(flight) : []),
    ...scanFlatSkillObjects(html),
  ]);
}

function normalizeSkillsshItem(it: any): SkillsShSkill | null {
  if (!it || typeof it !== "object") return null;
  const source = it.source ?? it.repo ?? it.owner_repo;
  const skillId = it.skillId ?? it.skill_id ?? it.slug ?? it.name;
  if (typeof source !== "string" || typeof skillId !== "string") return null;
  return {
    id: it.id && typeof it.id === "string" ? it.id : `${source}/${skillId}`,
    skillId,
    name: typeof it.name === "string" ? it.name : skillId,
    source,
    installs: Number(it.installs ?? it.install_count ?? 0) || 0,
  };
}

/** 拉取榜单（alltime / trending / hot），5 分钟缓存。 */
export async function fetchLeaderboard(board: SkillsLeaderboard): Promise<SkillsShSkill[]> {
  const key = `leaderboard_${board}`;
  const cached = getCache<SkillsShSkill[]>(key, LEADERBOARD_TTL);
  if (cached) return cached;
  const url = board === "alltime" ? `${BASE}/` : `${BASE}/${board}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) {
    logEvent({
      level: "warn",
      source: "skills",
      event: "skills.market.fetch_failed",
      message: `skills.sh ${board} HTTP ${res.status}`,
      detail: { board, url, status: res.status },
    });
    throw new Error(`skills.sh ${board} HTTP ${res.status}`);
  }
  const html = await res.text();
  const items = parseLeaderboardHtml(html);
  if (items.length === 0) {
    // 站点改版 / 被挡时的表现是"榜单永远空的"，这是唯一能看出"页面结构变了"的信号。
    // flightLength 是关键区分信号：>0 说明 RSC 数据在、只是字段名变了；0 说明整页换形态了。
    logEvent({
      level: "warn",
      source: "skills",
      event: "skills.market.parse_empty",
      message: `skills.sh ${board} 解析不到条目（页面结构可能变了）`,
      detail: { board, url, htmlLength: html.length, flightLength: decodeRscFlight(html).length },
    });
    throw new Error("skills.sh parse empty");
  }
  setCache(key, items);
  return items;
}

/** 搜索（JSON API，limit 默认 60、上限 300）。 */
export async function searchSkillssh(query: string, limit = 60): Promise<SkillsShSkill[]> {
  const q = query.trim();
  if (!q) return [];
  const effective = Math.min(Math.max(1, limit), 300);
  const res = await fetchWithTimeout(
    `${BASE}/api/search?q=${encodeURIComponent(q)}&limit=${effective}`,
  );
  if (!res.ok) {
    logEvent({
      level: "warn",
      source: "skills",
      event: "skills.market.search_failed",
      message: `skills.sh search HTTP ${res.status}`,
      detail: { query: q, status: res.status },
    });
    throw new Error(`skills.sh search HTTP ${res.status}`);
  }
  const json = await res.json();
  const items: unknown[] = Array.isArray(json) ? json : (json?.skills ?? []);
  const out: SkillsShSkill[] = [];
  for (const it of items) {
    const s = normalizeSkillsshItem(it);
    if (s) out.push(s);
  }
  return out;
}
