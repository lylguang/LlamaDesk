/**
 * 作品封面与歌单封面。
 *
 * **没有真实封面图**：StepFun / MiniMax 的生音乐接口都不返回封面，本地也不生产图，
 * 所以封面一律由**内容确定性生成**——同一首歌（或同一个歌单拼图）每次进来颜色一致，
 * 既不会出现"每次刷新都换一张"的错觉，也能靠颜色把列表里的条目区分开。
 * 真有了封面图（比如将来接了 AI 绘图）在这里加一个 `coverUrl` 分支即可，调用点不用动。
 */
import type { CSSProperties, ReactNode } from "react";
import { MusicIcon, PlayIcon } from "lucide-react";

import { cn } from "@/mainview/lib/utils";

/**
 * 封面配色：**一组挑过的双色深调**，不是随机色相。
 *
 * 之前按 `hash % 360` 直接取色，结果是列表里一片高饱和彩虹（柠檬黄、荧光绿都出得来），
 * 同一个页面里彼此打架，看着廉价。这里收成 10 组"深底 + 同色系亮面"的双色（靛蓝、
 * 青灰、酒红、墨绿、赭石…），饱和度压在 40~60%、亮度压在 30~55%，颜色之间只有
 * 色相差别 —— 深色/浅色主题下都成立，拼图与列表也不会花。
 */
const COVER_PALETTES: readonly [number, number, number, number][] = [
  // [h1, s1, l1, h2]  →  亮面 hsl(h1 s1 l1)，深面是同色相压暗
  [222, 46, 52, 232], // 靛蓝
  [196, 42, 46, 210], // 青蓝
  [174, 38, 42, 186], // 松石
  [152, 36, 40, 168], // 墨绿
  [98, 34, 42, 128], // 苔绿
  [42, 52, 50, 24], // 赭金
  [18, 46, 48, 4], // 陶土
  [352, 44, 46, 12], // 酒红
  [326, 40, 46, 344], // 绛紫
  [268, 40, 48, 292], // 紫罗兰
];

/** FNV-1a：短字符串上分布够均匀，且不依赖任何运行时。 */
function hash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** 由种子算出的渐变底：同一底色系的亮面 + 深面，加一层斜向高光。 */
export function coverStyle(seed: string): CSSProperties {
  const h = hash(seed || "omni");
  const [hue, sat, light, hue2] = COVER_PALETTES[h % COVER_PALETTES.length]!;
  return {
    backgroundImage: [
      "radial-gradient(circle at 26% 16%, rgba(255,255,255,0.22), transparent 62%)",
      `linear-gradient(150deg, hsl(${hue} ${sat}% ${light}%) 0%, hsl(${hue2} ${sat - 6}% ${Math.round(light * 0.62)}%) 58%, hsl(${hue2} ${sat - 8}% ${Math.round(light * 0.4)}%) 100%)`,
    ].join(", "),
  };
}

/** 封面种子：记录 id 优先（稳定、唯一），没有 id 时退回歌名。 */
export function recordSeed(record: { id: number; title?: string | null }): string {
  return record.title?.trim() ? `${record.id}:${record.title.trim()}` : String(record.id);
}

/**
 * 单张封面。
 *
 * **有真封面就用真封面**（用户上传或一键生成的，见 bun/music-covers.ts），只有还没设
 * 封面时才退回按种子生成的渐变 —— 渐变不是"设计"，它是兜底：让列表在没有图的时候
 * 也不至于是一排灰方块。
 *
 * `label` 只在渐变模式下当水印用（取首字）；真封面上再盖一个字就脏了。
 */
export function MusicCover({
  seed,
  label,
  src,
  className,
  children,
}: {
  seed: string;
  label?: string;
  /** 真封面地址（媒体服务提供）；为空则画渐变。 */
  src?: string | null;
  className?: string;
  children?: ReactNode;
}) {
  const char = label?.trim()?.[0];
  return (
    <span
      style={src ? undefined : coverStyle(seed)}
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden rounded-md select-none",
        className,
      )}
    >
      {src ? (
        <img
          src={src}
          alt=""
          draggable={false}
          className="absolute inset-0 size-full object-cover"
        />
      ) : char ? (
        <span className="relative text-[42%] leading-none font-semibold text-white/90 drop-shadow-sm">
          {char}
        </span>
      ) : (
        <MusicIcon className="relative size-[38%] text-white/85" />
      )}
      <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/25 to-transparent" />
      {children}
    </span>
  );
}

/**
 * 歌单封面：1 / 2 / 4 格拼图，和网易云的歌单封面是同一种做法 ——
 * 前四首歌各占一格，一眼能看出歌单之间的差别；空歌单退回一张灰底。
 */
export function PlaylistCover({
  seeds,
  className,
}: {
  /** 前四首的 id + 歌名 + 封面地址（后端按歌单内顺序给，见 music-playlists.ts）。 */
  seeds: { id: number; title: string; coverUrl: string | null }[];
  className?: string;
}) {
  const tiles = seeds.slice(0, 4);
  if (tiles.length === 0) {
    return (
      <span
        className={cn(
          "flex shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted",
          className,
        )}
      >
        <MusicIcon className="size-[38%] text-muted-foreground/70" />
      </span>
    );
  }
  const cols = tiles.length === 1 ? 1 : 2;
  return (
    <span
      className={cn("grid shrink-0 gap-px overflow-hidden rounded-md bg-border", className)}
      style={{
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridTemplateRows: tiles.length <= 2 ? "1fr" : "repeat(2, minmax(0, 1fr))",
      }}
    >
      {tiles.map((t) => (
        <MusicCover
          key={t.id}
          seed={recordSeed(t)}
          label={t.title}
          src={t.coverUrl}
          className="rounded-none"
        />
      ))}
    </span>
  );
}

/** 正在播放的跳动条（列表里那一行、播放条上都要用）。 */
export function PlayingBars({ className }: { className?: string }) {
  return (
    <span className={cn("flex h-3.5 items-end gap-0.5", className)} aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="music-eq w-[3px] rounded-full bg-primary"
          style={{ height: "100%", animationDelay: `${i * 0.18}s` }}
        />
      ))}
    </span>
  );
}

/** 覆盖在封面上的播放按钮（hover 时出现，网易云歌单页的大封面就是这种）。 */
export function CoverPlayOverlay({ playing }: { playing?: boolean }) {
  return (
    <span className="absolute inset-0 flex items-center justify-center bg-black/35 opacity-0 transition-opacity group-hover/cover:opacity-100">
      {playing ? (
        <PlayingBars className="h-5 text-white" />
      ) : (
        <PlayIcon className="size-1/3 fill-white text-white drop-shadow" />
      )}
    </span>
  );
}
