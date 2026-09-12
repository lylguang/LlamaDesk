import * as React from "react";
import { Textarea as AppicaTextarea } from "@appica/ui-react/textarea";

type TextareaProps = React.ComponentProps<typeof AppicaTextarea>;

function Textarea({ className, ...props }: TextareaProps) {
  return <AppicaTextarea className={className} {...props} />;
}

export { Textarea, type TextareaProps };
