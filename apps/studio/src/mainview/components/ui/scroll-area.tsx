import * as React from "react";
import { ScrollArea as AppicaScrollArea } from "@appica/ui-react/scroll-area";

/**
 * 滚动区（Appica 适配器）。上游在 Radix 版里踩过的两条坑同样适用：
 *
 * 1. 视口是真正滚动的那层，高度是 height:100% —— 只有祖先链上存在**确定高度**时
 *    百分比才会解析成滚动高度。调用方要给滚动区一个确定高度（h-*、h-full、
 *    flex-1 + 父级 h-*），min-h-0 保证它在 flex 里能收缩；只给 max-h 会被内容
 *    撑开、列表被裁掉且拉不动。
 * 2. 原生滚动条要藏掉，否则会和自定义拇指同时出现（系统开着"始终显示滚动条"
 *    时更明显）。Appica 的 ScrollArea 已内置处理。
 */
function ScrollArea(props: React.ComponentProps<typeof AppicaScrollArea>) {
  return <AppicaScrollArea data-slot="scroll-area" {...props} />;
}

export { ScrollArea };
