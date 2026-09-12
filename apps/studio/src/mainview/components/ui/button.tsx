import * as React from "react";
import { Slot } from "radix-ui";
import {
  Button as AppicaButton,
  buttonVariants as appicaButtonVariants,
} from "@appica/ui-react/button";

import { cn } from "@lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

/*
 * shadcn → Appica variant/size 语义映射:
 * default(深色实心)→ primary,secondary(中性容器)→ soft,link 无对应变体用 ghost + 下划线类
 */
const variantMap = {
  default: "primary",
  secondary: "soft",
  outline: "outline",
  ghost: "ghost",
  destructive: "destructive",
  link: "ghost",
} as const;

const sizeMap = {
  default: "md",
  xs: "sm",
  sm: "sm",
  lg: "lg",
  icon: "icon-md",
  "icon-xs": "icon-sm",
  "icon-sm": "icon-sm",
  "icon-lg": "icon-lg",
} as const;

type LocalVariant = keyof typeof variantMap;
type LocalSize = keyof typeof sizeMap;

const linkClasses =
  "hover:before:bg-transparent! data-popup-open:before:bg-transparent! data-pressed:before:bg-transparent! text-primary underline-offset-4 hover:underline";

function buttonClasses(variant: LocalVariant, size: LocalSize, className?: string) {
  return cn(
    variant === "link" && linkClasses,
    className,
  );
}

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  tooltip,
  ...props
}: React.ComponentProps<"button"> & {
  variant?: LocalVariant;
  size?: LocalSize;
  asChild?: boolean;
  tooltip?: string;
}) {
  const result = asChild ? (
    <Slot.Root
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(
        appicaButtonVariants({ variant: variantMap[variant], size: sizeMap[size] }),
        buttonClasses(variant, size, className),
      )}
      {...props}
    />
  ) : (
    <AppicaButton
      variant={variantMap[variant]}
      size={sizeMap[size]}
      data-variant={variant}
      data-size={size}
      className={buttonClasses(variant, size, className)}
      {...(props as React.ComponentProps<typeof AppicaButton>)}
    />
  );

  if (!tooltip) return result;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{result}</TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

export { Button, buttonClasses as buttonVariants };
