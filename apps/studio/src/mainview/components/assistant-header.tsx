import { CpuIcon } from "lucide-react";

import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";

/** 时间戳：同一年只写 月/日 时:分，跨年才补年份（会话列表里的读法一致）。 */
export function formatMessageTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.getFullYear() === new Date().getFullYear()
    ? `${d.getMonth() + 1}/${d.getDate()} ${clock}`
    : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${clock}`;
}

/**
 * 助手消息的身份行：名称 + 这条用的模型。
 *
 * 模型标签是这里的关键：一部会话里可能换过模型（本地 / 云端、不同尺寸的模型），
 * 而"这条回答是谁生成的"直接影响用户怎么读它 —— 只有头部能说清楚。
 *
 * 写成一段淡色文字而不是带边框的胶囊：它紧挨着正文，胶囊的边框会和正文里的
 * 代码块、表格抢边框（一屏里出现四五种框，读者就分不出层级了）。时间不在这儿，
 * 在消息底部的 meta 行 —— 那行本来就要放操作条与用量。
 */
export function AssistantHeader({
  model,
  className,
}: {
  model?: string;
  className?: string;
}) {
  const t = useT();
  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <span className="shrink-0 text-sm leading-5 font-semibold">
        {t("chat.assistantName")}
      </span>
      {model && (
        <span className="flex min-w-0 items-center gap-1 text-xs leading-5 text-muted-foreground">
          <CpuIcon className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{model}</span>
        </span>
      )}
    </div>
  );
}
