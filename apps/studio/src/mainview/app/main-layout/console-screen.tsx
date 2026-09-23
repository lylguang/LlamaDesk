import { useState } from "react";
import { TerminalSquareIcon } from "lucide-react";

import { AppLogView } from "@components/app-log-view";
import { FallbackModelsPanel } from "@components/fallback-models-panel";
import {
  ServedModelsPanel,
  ServedModelLogs,
  StopAllServedButton,
} from "@components/served-models-panel";
import { PageShell } from "@components/setting-ui";
import { useServedStore } from "@stores/served";
import { useT } from "@stores/ui-lang";
import { cn } from "@lib/utils";

/** 「最近 N 条」的档位：应用日志按条、模型输出按行，两处共用同一个控件。 */
const LIMIT_CHOICES = [100, 500, 2000];
/** 来源切换器里表示「应用日志」的那一项（模型实例用它们自己的 id，不会撞上）。 */
const APP_LOG = "__app__";

/** 来源 / 档位 chip：一套样式，选中态就是「当前在看这个」。 */
function Chip({
  label,
  hint,
  active,
  onClick,
}: {
  label: string;
  hint?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors",
        active ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
      {hint && <span className="text-muted-foreground/70">{hint}</span>}
    </button>
  );
}

/**
 * 控制台：**已启动模型**的总览与操作台 + **应用日志**的控制台。
 *
 * 一个本地模型 = 一个服务器进程，可以同时跑多个（各自端口）；这里启动、卸载、
 * 重启、设当前模型，并给每个实例挂一份实时输出。对话 / Agent 的模型选择器
 * 只列这里已经启动的实例 —— 启动是控制台的事，不在下拉框里等冷启动。
 *
 * 下半屏的日志区有两类来源，用一个切换器覆盖：**应用日志**（`app.log`，全子系统的
 * 事件级记录，还能翻轮转文件）与**每个实例的实时输出**（推理服务器 stdout，只有内存）。
 * 两者数据形态不同（前者是结构化条目，后者是一整段文本），所以各自渲染，但级别 /
 * 最近 N 条这些控件是同一套。
 */
export function ConsoleScreen() {
  const t = useT();
  const models = useServedStore((s) => s.models);
  const running = models.filter((m) => m.status === "running").length;
  const [source, setSource] = useState<string>(APP_LOG);
  const [limit, setLimit] = useState<number>(LIMIT_CHOICES[0]!);
  // 选中的实例被卸载后要落回应用日志，不能对着一个已经不存在的实例发呆。
  const active = source !== APP_LOG && models.some((m) => m.id === source) ? source : APP_LOG;

  return (
    <PageShell className="h-full min-h-0 gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
          <TerminalSquareIcon className="size-4" />
        </span>
        <h2 className="text-lg font-semibold tracking-tight">{t("console.title")}</h2>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground tabular-nums">
          {t("console.runningCount", { n: String(running) })}
        </span>
        <span className="text-[11px] text-muted-foreground/70">{t("console.subtitle")}</span>
        <div className="flex-1" />
        <StopAllServedButton />
      </div>

      {/* 模型列表可滚动（多开时不会把日志挤没），日志区吃剩余高度 */}
      <div className="flex max-h-[45%] min-h-0 shrink-0 flex-col gap-2 overflow-y-auto pr-1">
        <ServedModelsPanel />
        {/* 备选模型链：只在默认模型起不来时才起作用，所以放在列表下面、日志上面 */}
        <FallbackModelsPanel />
      </div>

      <div className="flex flex-wrap items-center gap-2" data-slot="log-source-switcher">
        <span className="text-[11px] text-muted-foreground">{t("console.logSource")}</span>
        <Chip
          label={t("console.appLog")}
          active={active === APP_LOG}
          onClick={() => setSource(APP_LOG)}
        />
        {/* 没有实例时只留「应用日志」一项：切换器本身仍然是「现在看的是什么」的标注 */}
        {models.map((m) => (
          <Chip
            key={m.id}
            label={m.label || m.servedName}
            hint={m.port ? `:${m.port}` : undefined}
            active={active === m.id}
            onClick={() => setSource(m.id)}
          />
        ))}
        <div className="flex-1" />
        <span className="text-[11px] text-muted-foreground" title={t("console.logLimitHint")}>
          {t("console.logLimit")}
        </span>
        <div className="flex items-center gap-1">
          {LIMIT_CHOICES.map((n) => (
            <Chip
              key={n}
              label={String(n)}
              active={limit === n}
              onClick={() => setLimit(n)}
            />
          ))}
        </div>
      </div>

      {active === APP_LOG ? (
        <AppLogView limit={limit} />
      ) : (
        <ServedModelLogs modelId={active} limit={limit} />
      )}
    </PageShell>
  );
}
