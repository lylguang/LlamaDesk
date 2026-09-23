// 音乐工作台：创作 / 歌单 / 全部作品三个视图 + 常驻的底部播放条（右侧可拉出歌词 / 播放队列）。
//
// 两件事挂在这一层，因为它们要覆盖所有视图、切视图不能中断：
//  1. 在途任务的轮询（`useMusicRecordsPolling`）；
//  2. 播放队列与最新记录的同步（`patchQueue`）—— 生成中的作品拿到音频后，
//     队列里那份快照要跟着变成可播放，否则用户点播放会毫无反应。
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import { rpcClient } from "@lib/rpc";
import { useMusicStore } from "@stores/music";
import { useMusicPlayer } from "@stores/music-player";
import { useMusicRecordsPolling } from "@hooks/use-music-polling";
import { HistoryScreen } from "./history";
import { GenerateTab } from "./generate-tab";
import { NowPlayingView } from "./now-playing";
import { PlaylistView } from "./playlist-view";
import { MusicPlayerBar } from "./player-bar";
import { MusicPanel } from "./player-panel";

export function MusicScreen() {
  useMusicRecordsPolling();
  const view = useMusicStore((s) => s.view);
  const playlistId = useMusicStore((s) => s.playlistId);
  const nowPlaying = useMusicStore((s) => s.nowPlaying);

  // 与轮询共用同一个 queryKey（同一份缓存，不会多发请求），只为了拿到最新记录回填队列。
  const { data } = useQuery({
    queryKey: ["music-records"],
    queryFn: () => rpcClient.listMusicRecords(undefined),
  });
  const patchQueue = useMusicPlayer((s) => s.patchQueue);
  useEffect(() => {
    if (data?.records) patchQueue(data.records);
  }, [data, patchQueue]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1">
        {/* relative：单曲播放页盖在这一层之上（absolute inset-0），底部播放条留给它用。 */}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {view === "playlist" && playlistId != null ? (
            <PlaylistView playlistId={playlistId} />
          ) : view === "history" ? (
            <HistoryScreen />
          ) : (
            <GenerateTab />
          )}
          {nowPlaying && <NowPlayingView />}
        </div>
        <MusicPanel />
      </div>
      <MusicPlayerBar />
    </div>
  );
}
