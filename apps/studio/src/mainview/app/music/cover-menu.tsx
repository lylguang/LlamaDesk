/**
 * 「换封面」菜单：一键生成 / 本地上传 / 换回渐变。
 *
 * 三个动作都走同一个菜单，是因为它们回答的是同一个问题 ——"这张封面长什么样"。
 * 分开摆会变成三个用途不明的按钮；摆在一起，用户一眼就知道有哪几种做法。
 *
 * 生成要经过生图管线（云端几十秒、本地更久），所以按钮上要有转圈与说明，
 * 失败原因原样显示在菜单里（这个应用没有 toast，就地反馈最稳）。
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ImageIcon, Loader2Icon, RotateCcwIcon, SparklesIcon, UploadIcon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@ui/popover";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";

/** 上传允许的图片类型（与主进程侧的 sharp 解码能力对应）。 */
const IMAGE_TYPES = "png,jpg,jpeg,webp,gif,bmp";

export function CoverMenu({
  recordId,
  hasCover,
  className,
  compact,
  onChanged,
}: {
  recordId: number;
  /** 已经有真封面时多给一个「换回渐变」。 */
  hasCover: boolean;
  className?: string;
  compact?: boolean;
  /** 换完通知调用方（比如让曲目行刷新）。 */
  onChanged?: () => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["music-records"] });
    queryClient.invalidateQueries({ queryKey: ["music-playlist-tracks"] });
    queryClient.invalidateQueries({ queryKey: ["music-playlists"] });
    onChanged?.();
  };

  const generate = useMutation({
    mutationFn: () => rpcClient.generateMusicCover({ id: recordId }),
    onSuccess: (r) => {
      if (!r.ok) {
        setError(r.error ?? t("music.cover.generateFailed"));
        return;
      }
      setError(undefined);
      invalidate();
    },
    onError: (e) => setError(String(e)),
  });

  const upload = useMutation({
    mutationFn: async () => {
      const { paths } = await rpcClient.openFileDialog({ allowedFileTypes: IMAGE_TYPES });
      if (paths.length === 0) return undefined;
      return rpcClient.setMusicCover({ id: recordId, path: paths[0]! });
    },
    onSuccess: (r) => {
      if (!r) return; // 用户在文件框里点了取消
      if (!r.ok) {
        setError(r.error ?? t("music.cover.uploadFailed"));
        return;
      }
      setError(undefined);
      invalidate();
    },
    onError: (e) => setError(String(e)),
  });

  const reset = useMutation({
    mutationFn: () => rpcClient.clearMusicCover({ id: recordId }),
    onSuccess: (r) => {
      if (!r.ok) {
        setError(r.error ?? t("music.cover.resetFailed"));
        return;
      }
      setError(undefined);
      invalidate();
    },
    onError: (e) => setError(String(e)),
  });

  const busy = generate.isPending || upload.isPending || reset.isPending;

  const item = (
    icon: React.ReactNode,
    label: string,
    onClick: () => void,
    opts?: { hint?: string; danger?: boolean },
  ) => (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-muted/70 disabled:opacity-60",
        opts?.danger && "text-destructive hover:bg-destructive/10",
      )}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="flex min-w-0 flex-col">
        <span className="text-[11px]">{label}</span>
        {opts?.hint && (
          <span className="text-[10px] leading-relaxed text-muted-foreground">{opts.hint}</span>
        )}
      </span>
    </button>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size={compact ? "icon-sm" : "sm"}
          tooltip={t("music.cover.change")}
          aria-label={t("music.cover.change")}
          className={cn(compact && "size-6", className)}
          onClick={(e) => e.stopPropagation()}
        >
          <ImageIcon className={compact ? "size-3" : "size-3.5"} />
          {!compact && <span>{t("music.cover.change")}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1.5" onClick={(e) => e.stopPropagation()}>
        <p className="px-2 py-1 text-[10px] font-medium text-muted-foreground">
          {t("music.cover.change")}
        </p>

        {item(
          generate.isPending ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <SparklesIcon className="size-3.5" />
          ),
          t("music.cover.generate"),
          () => generate.mutate(),
          { hint: t("music.cover.generateHint") },
        )}
        {item(
          upload.isPending ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <UploadIcon className="size-3.5" />
          ),
          t("music.cover.upload"),
          () => upload.mutate(),
          { hint: t("music.cover.uploadHint") },
        )}
        {hasCover &&
          item(
            <RotateCcwIcon className="size-3.5" />,
            t("music.cover.reset"),
            () => reset.mutate(),
            { danger: true },
          )}

        {error ? (
          <p className="px-2 py-1 text-[10px] leading-relaxed text-destructive">{error}</p>
        ) : (
          generate.isPending && (
            <p className="px-2 py-1 text-[10px] leading-relaxed text-muted-foreground">
              {t("music.cover.generating")}
            </p>
          )
        )}
      </PopoverContent>
    </Popover>
  );
}
