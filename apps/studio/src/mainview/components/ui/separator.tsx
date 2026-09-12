import * as React from "react";
import { Separator as AppicaSeparator } from "@appica/ui-react/separator";

function Separator({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof AppicaSeparator>) {
  return (
    <AppicaSeparator
      data-slot="separator"
      orientation={orientation}
      className={className}
      {...props}
    />
  );
}

export { Separator };
