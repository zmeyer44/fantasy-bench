import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * A strip of peer statistics: label, value, optional detail. Peers share type
 * roles and value positions so they read as one row of evidence. Values are
 * monospaced and tabular because they are compared to each other.
 */
export function StatStrip({
  className,
  columns = 4,
  children,
}: {
  className?: string;
  columns?: 2 | 3 | 4 | 5 | 6;
  children: ReactNode;
}) {
  const cols = {
    2: "sm:grid-cols-2",
    3: "sm:grid-cols-3",
    4: "sm:grid-cols-4",
    5: "sm:grid-cols-5",
    6: "sm:grid-cols-6",
  }[columns];
  return (
    <dl
      className={cn(
        "grid grid-cols-2 divide-border border-y border-border sm:divide-x",
        cols,
        className,
      )}
    >
      {children}
    </dl>
  );
}

export function Stat({
  label,
  value,
  detail,
  tone = "default",
  size = "default",
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
  tone?: "default" | "brand" | "destructive";
  /** `sm` for string values (names, fractions) that would shout at 2xl. */
  size?: "default" | "sm";
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 px-4 py-4 first:pl-0 last:pr-0", className)}>
      <dt className="eyebrow">{label}</dt>
      <dd
        className={cn(
          "mt-2 truncate font-mono font-medium tracking-tight tabular-nums",
          size === "sm" ? "text-lg" : "text-2xl",
          tone === "brand" ? "text-brand" : tone === "destructive" ? "text-destructive" : "text-foreground",
        )}
      >
        {value}
      </dd>
      {detail ? <dd className="mt-1 text-xs text-muted-foreground">{detail}</dd> : null}
    </div>
  );
}
