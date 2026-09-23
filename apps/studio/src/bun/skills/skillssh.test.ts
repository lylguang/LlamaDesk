/**
 * 榜单页解析：线上曾是「页面结构一变就零条」——原始 HTML 上打正则，而站点已换成
 * Next.js App Router（数据整段转义在 RSC flight 里，字段顺序也不是正则假设的那个）。
 * 这里把三种形态都钉住，改版时至少能看到是哪一种先失效。
 */
import { expect, test } from "bun:test";
import { decodeRscFlight, parseLeaderboardHtml } from "./skillssh";

/** 按 Next 的真实形态拼一段 flight：整段文本被 JSON.stringify 成一个 JS 字符串字面量。 */
function flightHtml(...chunks: string[]): string {
  return chunks.map((c) => `<script>self.__next_f.push([1,${JSON.stringify(c)}])</script>`).join("");
}

/** 现网 payload：`initialSkills` 是数组，条目字段顺序 source → skillId → name → installs。 */
function flightText(items: unknown[]): string {
  return (
    `21:300\n4e:["$","$L55",null,{"initialSkills":${JSON.stringify(items)},` +
    `"totalSkills":${items.length}}]\n`
  );
}

const ITEMS = [
  {
    source: "vercel-labs/skills",
    skillId: "find-skills",
    name: "find-skills",
    installs: 3419849,
    weeklyInstalls: [107969, 101120],
  },
  {
    source: "anthropics/skills",
    skillId: "pdf",
    name: "pdf",
    installs: 196649,
  },
];

test("App Router flight 形态：解出条目，source 在 skillId 之前", () => {
  const skills = parseLeaderboardHtml(flightHtml(flightText(ITEMS)));
  expect(skills).toHaveLength(2);
  expect(skills[0]).toEqual({
    id: "vercel-labs/skills/find-skills",
    skillId: "find-skills",
    name: "find-skills",
    source: "vercel-labs/skills",
    installs: 3419849,
  });
  expect(skills[1]!.id).toBe("anthropics/skills/pdf");
  expect(skills[1]!.installs).toBe(196649);
});

test("flight 被切成多个 chunk：拼接后仍能解出", () => {
  const text = flightText(ITEMS);
  const cut = text.indexOf('"pdf"');
  const html = flightHtml(text.slice(0, cut), text.slice(cut));
  expect(decodeRscFlight(html).length).toBeGreaterThan(0);
  expect(parseLeaderboardHtml(html).map((s) => s.id)).toEqual([
    "vercel-labs/skills/find-skills",
    "anthropics/skills/pdf",
  ]);
});

test("__NEXT_DATA__（旧 Pages Router 形态）仍认得", () => {
  const html =
    `<script id="__NEXT_DATA__" type="application/json">` +
    JSON.stringify({ props: { pageProps: { initialSkills: { items: ITEMS } } } }) +
    `</script>`;
  expect(parseLeaderboardHtml(html)).toHaveLength(2);
});

test("没有 initialSkills 标记时退回扁平对象扫描（字段顺序无关）", () => {
  const escaped =
    `<script>self.__next_f.push([1,${JSON.stringify(
      `4e:["$",null,{"items":[{"source":"acme/skills","skillId":"alpha","name":"alpha","installs":12},` +
        `{"skillId":"beta","source":"acme/skills","installs":3}]}]`,
    )}])</script>`;
  expect(parseLeaderboardHtml(escaped).map((s) => s.id)).toEqual([
    "acme/skills/alpha",
    "acme/skills/beta",
  ]);
});

test("同一 id 只留一条；认不出的页面返回空数组而不是抛错", () => {
  const dup = flightText([ITEMS[0], ITEMS[0]]);
  expect(parseLeaderboardHtml(flightHtml(dup))).toHaveLength(1);
  expect(parseLeaderboardHtml("<html><body>maintenance</body></html>")).toEqual([]);
  expect(parseLeaderboardHtml("")).toEqual([]);
});

test("缺 source / skillId 的条目被丢掉，其余照常返回", () => {
  const html = flightHtml(
    flightText([{ skillId: "orphan", installs: 1 }, { source: "a/b" }, ITEMS[1]]),
  );
  expect(parseLeaderboardHtml(html).map((s) => s.id)).toEqual(["anthropics/skills/pdf"]);
});
