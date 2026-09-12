import * as React from "react";
import {
  Collapsible as AppicaCollapsible,
  CollapsibleContent,
  CollapsibleTrigger as AppicaCollapsibleTrigger,
} from "@appica/ui-react/collapsible";

function Collapsible(props: React.ComponentProps<typeof AppicaCollapsible>) {
  return <AppicaCollapsible data-slot="collapsible" {...props} />;
}

/* Base UI 不支持 asChild,用 render prop 等价替换 */
function CollapsibleTrigger({
  asChild,
  children,
  ...props
}: React.ComponentProps<typeof AppicaCollapsibleTrigger> & { asChild?: boolean }) {
  if (asChild && React.isValidElement(children)) {
    return <AppicaCollapsibleTrigger render={children} {...props} />;
  }
  return <AppicaCollapsibleTrigger {...props}>{children}</AppicaCollapsibleTrigger>;
}

export { Collapsible, CollapsibleContent, CollapsibleTrigger };
