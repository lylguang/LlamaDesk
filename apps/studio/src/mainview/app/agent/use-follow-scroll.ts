import { useCallback, useRef } from "react";

/** 距底多少像素以内算「还在跟着看」。与对话页同一口径。 */
export const FOLLOW_THRESHOLD_PX = 64;

/** 纯函数：根据滚动位置判断是不是还在跟随。抽出来是为了能直接单测。 */
export function isFollowing(el: { scrollHeight: number; scrollTop: number; clientHeight: number }): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD_PX;
}

/**
 * 跟随模式：没往上翻就跟着新内容贴底；翻上去了就别抢用户的滚动条
 * （流式输出时想回看上一段，是 Agent 页最常被拽回底部打断的场景）。
 */
export function useFollowScroll(scrollRef: { current: HTMLElement | null }) {
  const followingRef = useRef(true);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    followingRef.current = isFollowing(el);
  }, [scrollRef]);

  const scrollToBottomIfFollowing = useCallback(() => {
    if (!followingRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [scrollRef]);

  return { onScroll, scrollToBottomIfFollowing };
}
