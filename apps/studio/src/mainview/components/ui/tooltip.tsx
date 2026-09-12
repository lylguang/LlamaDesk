import * as React from "react";
import {
  Tooltip as AppicaTooltip,
  TooltipContent as AppicaTooltipContent,
  TooltipProvider as AppicaTooltipProvider,
  TooltipTrigger as AppicaTooltipTrigger,
} from "@appica/ui-react/tooltip";

/*
 * Base UI 不支持 asChild,用 render prop 等价替换;
 * Provider 的 delayDuration(Radix 命名)映射为 Base UI 的 delay。
 */
function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof AppicaTooltipProvider> & { delayDuration?: number }) {
  return <AppicaTooltipProvider delay={delayDuration} {...props} />;
}

function Tooltip(props: React.ComponentProps<typeof AppicaTooltip>) {
  return <AppicaTooltip {...props} />;
}

function TooltipTrigger({
  asChild,
  children,
  ...props
}: React.ComponentProps<typeof AppicaTooltipTrigger> & { asChild?: boolean }) {
  if (asChild && React.isValidElement(children)) {
    return <AppicaTooltipTrigger render={children} {...props} />;
  }
  return <AppicaTooltipTrigger {...props}>{children}</AppicaTooltipTrigger>;
}

function TooltipContent(props: React.ComponentProps<typeof AppicaTooltipContent>) {
  return <AppicaTooltipContent {...props} />;
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
