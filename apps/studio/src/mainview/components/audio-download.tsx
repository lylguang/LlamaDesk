import { rpcClient } from "@lib/rpc";
import { useT } from "@stores/ui-lang";
import { MediaDownloadButton } from "./record-actions";

/** 从内置音频服务 URL 推导扩展名（默认 mp3）。 */
function extFromUrl(url: string): string {
  const m = /\.([A-Za-z0-9]+)(?:\?|$)/.exec(url);
  return (m?.[1] ?? "mp3").toLowerCase();
}

/** 生成适合做文件名的建议名称，例如 qwen3-tts-0.6b-20260908143000.mp3。 */
export function audioFileName(url: string, label?: string): string {
  const safe =
    (label ?? "audio")
      .replace(/[\\/:*?"<>|\s·]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "audio";
  const now = new Date()
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 14);
  return `${safe}-${now}.${extFromUrl(url)}`;
}

/**
 * 下载按钮：弹出目录选择框并把对应音频复制到所选目录。
 * 保存成功后短暂显示对勾，tooltip 显示保存路径。
 *
 * 反馈逻辑在 `MediaDownloadButton`（生图 / 视频 / 音乐 / 语音共用），这里只负责
 * 绑定 `saveAudioToFolder` 和语音页那套文案。
 */
export function AudioDownloadButton({
  url,
  filename,
  compact,
  className,
}: {
  url: string;
  filename: string;
  compact?: boolean;
  className?: string;
}) {
  const t = useT();
  return (
    <MediaDownloadButton
      compact={compact}
      className={className}
      save={() => rpcClient.saveAudioToFolder({ url, filename })}
      labels={{
        idle: t("voice.download"),
        saved: t("voice.downloaded"),
        failed: t("voice.downloadFailed"),
      }}
    />
  );
}
