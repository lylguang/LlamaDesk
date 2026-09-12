import * as React from "react";
import {
  Card as AppicaCard,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@appica/ui-react/card";

/* Appica 卡片没有 CardContent/CardAction,提供兼容占位避免调用方破坏 */
function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={className} {...props} />;
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-action" className={className} {...props} />;
}

function Card({ className, ...props }: React.ComponentProps<typeof AppicaCard>) {
  return <AppicaCard data-slot="card" className={className} {...props} />;
}

export { Card, CardHeader, CardFooter, CardTitle, CardAction, CardDescription, CardContent };
