import type { ComponentPropsWithoutRef } from "react";

import { FIELD_CLASS } from "./input";
import { cn } from "./utils";

export function Select({ className, ...props }: ComponentPropsWithoutRef<"select">) {
  return <select className={cn(FIELD_CLASS, "h-9 py-0 pr-8", className)} {...props} />;
}
