import * as React from "react";
import { Skeleton as AppicaSkeleton } from "@appica/ui-react/skeleton";

function Skeleton({ className, ...props }: React.ComponentProps<typeof AppicaSkeleton>) {
  return <AppicaSkeleton data-slot="skeleton" className={className} {...props} />;
}

export { Skeleton };
