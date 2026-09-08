import type { ComponentPropsWithoutRef } from "react";

import { cn } from "./utils";

export type BadgeTone = "neutral" | "accent" | "warning" | "danger" | "outline";

const TONES: Record<BadgeTone, string> = {
  neutral: "border-line bg-surface-muted text-ink-muted",
  accent: "border-accent/40 bg-accent-soft text-accent-strong",
  warning: "border-warning/40 bg-warning/15 text-warning",
  danger: "border-danger/40 bg-danger/15 text-danger",
  outline: "border-line-strong bg-transparent text-ink-muted",
};

export type BadgeProps = ComponentPropsWithoutRef<"span"> & { tone?: BadgeTone };

export function Badge({ tone = "neutral", className, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider",
        TONES[tone],
        className,
      )}
      {...props}
    />
  );
}
