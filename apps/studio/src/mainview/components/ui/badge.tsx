import * as React from "react";
import { Badge as AppicaBadge } from "@appica/ui-react/badge";

/* shadcn → Appica variant 语义映射:secondary/ghost/link(中性)→ soft,destructive → error */
const variantMap = {
  default: "primary",
  secondary: "soft",
  ghost: "soft",
  destructive: "error",
  outline: "outline",
  link: "soft",
} as const;

type LocalVariant = keyof typeof variantMap;

function Badge({
  className,
  variant = "default",
  ...props
}: Omit<React.ComponentProps<typeof AppicaBadge>, "variant"> & { variant?: LocalVariant }) {
  return <AppicaBadge variant={variantMap[variant]} className={className} {...props} />;
}

export { Badge };
