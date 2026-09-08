import type { ComponentPropsWithoutRef } from "react";

import { FIELD_CLASS } from "./input";
import { cn } from "./utils";

export function Textarea({ className, ...props }: ComponentPropsWithoutRef<"textarea">) {
  return <textarea className={cn(FIELD_CLASS, "min-h-24 font-mono text-xs", className)} {...props} />;
}
