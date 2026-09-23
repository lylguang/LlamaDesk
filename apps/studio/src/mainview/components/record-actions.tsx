import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CheckIcon, DownloadIcon, Loader2Icon, Trash2Icon } from "lucide-react";

import { Button } from "@ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ui/dialog";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";

/**
 * 各列表行共用的两个操作：保存到本地、删除。
 *
 * 生图 / 视频 / 音乐 / 语音四处原本只有语音的侧栏有这两个按钮，其余要么去
 * 「全部历史」页里找、要么干脆没有。放这里是为了让四处的反馈一致 ——
 * 特别是保存：静默复制（点完什么都不显示）在音乐那边踩过一次，用户只会以为按钮坏了。
 */

/** 保存动作的返回形状，与 `saveAudioToFolder` / `saveImageToDownloads` 两个 RPC 对齐。 */
export interface MediaSaveResult {
  ok: boolean;
  /** 用户在目录选择框里点了取消：既不打勾也不报错。 */
  canceled?: boolean;
  /** 落盘路径，成功时进 tooltip —— 只说「已保存」用户仍然找不到文件。 */
  path?: string;
  error?: string;
}

/** 按钮文案（未开始 / 已保存 / 失败）；不传则退回 `common.*` 的通用文案。 */
export interface MediaDownloadLabels {
  idle?: string;
  saved?: string;
  failed?: string;
}

/**
 * 「保存到本地」按钮：转圈 → 打勾（tooltip 换成落盘路径）→ 出错变红。
 *
 * `compact` 供侧栏列表行使用（20px，和第二行的 10px 小字同高），默认是播放器卡片上的
 * 28px 常规尺寸。
 */
export function MediaDownloadButton({
  save,
  labels,
  compact,
  className,
}: {
  /** 真正落盘的动作；返回路径时 tooltip 会显示它。 */
  save: () => Promise<MediaSaveResult>;
  labels?: MediaDownloadLabels;
  compact?: boolean;
  className?: string;
}) {
  const t = useT();
  const [saved, setSaved] = useState(false);
  const [savedPath, setSavedPath] = useState<string>();
  const [error, setError] = useState<string>();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const failureText = labels?.failed ?? t("common.downloadFailed");

  const mutation = useMutation({
    mutationFn: () => save(),
    onSuccess: (r) => {
      if (r.canceled) return;
      if (r.ok) {
        setError(undefined);
        setSavedPath(r.path);
        setSaved(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setSaved(false), 2000);
      } else {
        setError(r.error || failureText);
        setSaved(false);
      }
    },
    onError: () => {
      setError(failureText);
      setSaved(false);
    },
  });

  const tooltip = error
    ? error
    : saved
      ? savedPath
        ? `${labels?.saved ?? t("common.saved")}: ${savedPath}`
        : (labels?.saved ?? t("common.saved"))
      : (labels?.idle ?? t("common.download"));

  const iconClass = compact ? "size-3.5" : "size-4";
  const glyph = mutation.isPending ? (
    <Loader2Icon className={cn(iconClass, "animate-spin")} />
  ) : saved ? (
    <CheckIcon className={iconClass} />
  ) : (
    <DownloadIcon className={iconClass} />
  );

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      tooltip={tooltip}
      // tooltip 是浮层，不是可访问名 —— 图标按钮得自己带上，读屏和测试都靠它定位。
      aria-label={labels?.idle ?? t("common.download")}
      disabled={mutation.isPending}
      onClick={() => mutation.mutate()}
      className={cn(
        "shrink-0",
        // 与行内那颗删除按钮同尺寸同圆角，两个图标摆在一起才齐。
        compact && "size-5 rounded",
        error ? "text-destructive" : saved ? "text-emerald-500" : "text-muted-foreground",
        className,
      )}
    >
      {glyph}
    </Button>
  );
}

/**
 * 列表行上的删除按钮：默认藏着（调用方用 `group-hover/<name>:opacity-100` 放出来），
 * 点它只负责「问一句」—— 真正删不删由 `RecordDeleteDialog` 决定。
 */
export function RecordDeleteButton({
  onDelete,
  disabled,
  className,
}: {
  onDelete: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const t = useT();
  return (
    <button
      type="button"
      disabled={disabled}
      title={t("common.delete")}
      // 行本身可点（切换选中），别让删除顺手把选中也改掉。
      onClick={(e) => {
        e.stopPropagation();
        onDelete();
      }}
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-destructive disabled:opacity-50",
        className,
      )}
    >
      <Trash2Icon className="size-3.5" />
    </button>
  );
}

/** 删除前的确认框：四个列表长得一样，文案由调用方按页面给。 */
export function RecordDeleteDialog({
  open,
  onOpenChange,
  title,
  description,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  pending?: boolean;
  onConfirm: () => void;
}) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button variant="destructive" size="sm" disabled={pending} onClick={onConfirm}>
            {pending ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <Trash2Icon className="size-3.5" />
            )}
            {t("common.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
