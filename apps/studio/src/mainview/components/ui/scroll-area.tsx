import * as React from "react";
import { ScrollArea as AppicaScrollArea } from "@appica/ui-react/scroll-area";

function ScrollArea(props: React.ComponentProps<typeof AppicaScrollArea>) {
  return <AppicaScrollArea data-slot="scroll-area" {...props} />;
}

export { ScrollArea };
