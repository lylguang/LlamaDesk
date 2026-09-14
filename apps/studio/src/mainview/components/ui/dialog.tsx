import * as React from "react";
import {
  Dialog as AppicaDialog,
  DialogClose as AppicaDialogClose,
  DialogContent as AppicaDialogContent,
  DialogDescription,
  DialogFooter as AppicaDialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger as AppicaDialogTrigger,
} from "@appica/ui-react/dialog";

function Dialog(props: React.ComponentProps<typeof AppicaDialog>) {
  return <AppicaDialog data-slot="dialog" {...props} />;
}

function DialogTrigger(props: React.ComponentProps<typeof AppicaDialogTrigger>) {
  return <AppicaDialogTrigger data-slot="dialog-trigger" {...props} />;
}

function DialogClose(props: React.ComponentProps<typeof AppicaDialogClose>) {
  return <AppicaDialogClose data-slot="dialog-close" {...props} />;
}

/**
 * 弹窗默认宽度。必须是**普通**工具类，不能写成 `sm:max-w-sm`：Tailwind v4 的样式表里
 * 容器尺寸按 2xl…4xl…lg…md…sm…xl 排序，`max-w-sm` 恰好排在 `max-w-lg` / `max-w-4xl`
 * 之后，而 `sm:max-w-*` 这类媒体查询变体又整体排在普通工具类之后 —— 默认值会反过来盖掉
 * 调用方写的宽度，桌面上所有弹窗都被钉死在 384px（提示词详情弹窗因此被挤扁、底部按钮被
 * 裁掉）。写成普通类后，cn() 的 twMerge 判它和调用方的 max-w-* 是同类冲突，会自动让位。
 * 回归测试：dialog.test.tsx。
 */
export const DIALOG_DEFAULT_WIDTH = "max-w-[min(24rem,calc(100%-2rem))]";

/** 调用方一旦自己写了 max-w-*，就不再叠默认宽度。 */
export function dialogWidthClass(className?: string) {
  // 只认普通工具类：`sm:max-w-*` 表达的是「≥640px 用这个宽度」，小屏仍该吃到默认值，
  // 且变体在样式表里排在默认值之后，本来就赢。
  return (className ?? "")
    .split(/\s+/)
    .some((cls) => cls.startsWith("max-w-"))
    ? undefined
    : DIALOG_DEFAULT_WIDTH;
}

function DialogContent({
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof AppicaDialogContent> & {
  showCloseButton?: boolean;
}) {
  return <AppicaDialogContent closeButton={showCloseButton} {...props} />;
}

function DialogFooter(props: React.ComponentProps<typeof AppicaDialogFooter>) {
  return <AppicaDialogFooter data-slot="dialog-footer" {...props} />;
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
};
