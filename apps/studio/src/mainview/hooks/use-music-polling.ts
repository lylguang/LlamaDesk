import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { rpcClient } from "@lib/rpc";

/**
 * 在途音乐任务的轮询间隔。
 *
 * 与生视频一样是 5 秒：StepFun 官方建议 5 秒轮询一次；MiniMax 是同步协议，
 * 这里只负责发现"后台任务已经回填完了"。
 */
export const MUSIC_POLL_INTERVAL_MS = 5000;

/**
 * 在途音乐任务的轮询。
 *
 * 挂在 `MusicScreen` 这一层，而不是生成页里 —— 生成页在切到「历史」时会被卸载，
 * 轮询跟着停摆的话，在途任务会冻结在「生成中」。历史页与侧栏看的是同一份
 * `["music-records"]`，所以轮询放在两者之外，一处轮询三处刷新。
 *
 * 歌单曲目页读的是另一份缓存（`["music-playlist-tracks", id]`），这里要一并失效 ——
 * 否则在歌单里盯着一首生成中的作品，它会一直停在「生成中」，直到用户切走再切回来。
 */
export function useMusicRecordsPolling(): void {
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ["music-records"],
    queryFn: () => rpcClient.listMusicRecords(undefined),
  });

  const processingIds = (data?.records ?? [])
    .filter((r) => r.status === "processing")
    .map((r) => r.id)
    .join(",");

  const { data: pollData } = useQuery({
    queryKey: ["music-poll", processingIds],
    queryFn: () =>
      rpcClient.pollMusicRecords({
        ids: processingIds.split(",").filter(Boolean).map(Number),
      }),
    enabled: processingIds.length > 0,
    refetchInterval: MUSIC_POLL_INTERVAL_MS,
  });

  useEffect(() => {
    if (!pollData) return;
    queryClient.invalidateQueries({ queryKey: ["music-records"] });
    // 不带第二个参数 = 前缀匹配：所有已打开过的歌单曲目页（每个歌单一个 key）都刷新。
    queryClient.invalidateQueries({ queryKey: ["music-playlist-tracks"] });
  }, [pollData, queryClient]);
}
