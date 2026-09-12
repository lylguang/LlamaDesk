import * as React from "react";
import { Input as AppicaInput } from "@appica/ui-react/input";

type InputProps = React.ComponentProps<typeof AppicaInput>;

function Input({ className, type, ...props }: InputProps & { type?: string }) {
  return <AppicaInput type={type} className={className} {...props} />;
}

export { Input, type InputProps };
