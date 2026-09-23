import { Streamdown } from "streamdown";
import { createMathPlugin } from "@streamdown/math";
import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import { cjk } from "@streamdown/cjk";
import { ImageComponent } from "./image";

const math = createMathPlugin({
  singleDollarTextMath: true, // Enable $...$ syntax
  errorColor: "#dc2626",
});

const plugins = {
  math,
  code,
  mermaid,
  cjk,
};

export function Markdown({
  content,
  mode = "static",
}: {
  content: string;
  /**
   * 生成中传 "streaming"：半截的代码围栏 / 表格按"未完成"解析，
   * 否则每来一个 token 都可能把下面的段落闪成另一个样子。
   */
  mode?: "static" | "streaming";
}) {
  return (
    <Streamdown
      plugins={plugins}
      mode={mode}
      className="mx-auto flex max-w-3xl min-w-0 flex-col gap-3"
      components={{ img: ImageComponent as never }}
    >
      {content}
    </Streamdown>
  );
}
