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
