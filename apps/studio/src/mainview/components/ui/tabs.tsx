import * as React from "react";
import {
  Tabs as AppicaTabs,
  TabsContent,
  TabsList as AppicaTabsList,
  TabsTrigger,
} from "@appica/ui-react/tabs";

function Tabs(props: React.ComponentProps<typeof AppicaTabs>) {
  return <AppicaTabs data-slot="tabs" {...props} />;
}

/* 旧 TabsList variant=default(胶囊底色)对应 Appica 的 pill */
function TabsList({
  variant = "default",
  ...props
}: Omit<React.ComponentProps<typeof AppicaTabsList>, "variant"> & {
  variant?: "default" | "line";
}) {
  return (
    <AppicaTabsList
      data-slot="tabs-list"
      variant={variant === "default" ? "pill" : "line"}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
