import * as React from "react";
import { Spinner as AppicaSpinner } from "@appica/ui-react/spinner";

import { cn } from "@lib/utils";

/*
 * Appica Spinner 按 1em 尺寸渲染(默认 text-[2.5rem]);
 * 旧 Spinner 是 16px 图标,这里给默认 text-base(16px),调用方仍可用 className 覆盖。
 * currentColor 让颜色跟随上下文文字色,与旧 Loader2Icon 行为一致。
 */
function Spinner({ className, ...props }: React.ComponentProps<typeof AppicaSpinner>) {
  return <AppicaSpinner currentColor className={cn("text-base", className)} {...props} />;
}

export { Spinner };
