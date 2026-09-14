import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/index.css";
import "katex/dist/katex.min.css";

import { App } from "./app";
import { ErrorBoundary } from "./components/error-boundary";
import { Providers } from "./components/providers";
import { installClientErrorReporting } from "./lib/app-log";

// 全局错误也进统一日志（主进程 logs/app.log，source=client）：
// 渲染边界之外的未捕获错误、未处理的 Promise rejection 原本无处可查。
installClientErrorReporting();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* 最外层兜底：路由级 ErrorBoundary 只包住页面内容，侧栏 / AppRail / Provider
        里抛一个错就会把整棵树卸载 → 整个窗口白屏（知识库「新建」弹窗踩过一次）。
        套一层最外层边界，任何位置崩了都至少能看到错误信息和「重新加载」。 */}
    <ErrorBoundary>
      <Providers>
        <App />
      </Providers>
    </ErrorBoundary>
  </StrictMode>,
);
