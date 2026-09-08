import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/components/ui";

/**
 * A native `<details>` disclosure. Still no runtime of its own — the optional
 * `onOpenChange` exists so the trace viewer can load an overflowed tool result
 * the first time its disclosure is opened.
 *
 * A trace is read like a terminal log, so the disclosure is a ruled row rather
 * than a box: a hairline above it, mono summary, and an indented body.
 */
export function Collapsible({
  summary,
  meta,
  children,
  defaultOpen = false,
  tone = "default",
  className,
  onOpenChange,
}: {
  summary: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  tone?: "default" | "error";
  className?: string;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <details
      open={defaultOpen}
      onToggle={
        onOpenChange
          ? (event) => onOpenChange((event.currentTarget as HTMLDetailsElement).open)
          : undefined
      }
      className={cn("group border-t border-border first:border-t-0", className)}
    >
      <summary
        className={cn(
          "flex cursor-pointer list-none items-center gap-2 py-1.5 text-xs transition-colors",
          "hover:text-foreground focus-visible:outline-none",
          tone === "error" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        <ChevronRight
          aria-hidden
          className="size-3 shrink-0 text-ink-faint transition-transform group-open:rotate-90"
        />
        <span className="min-w-0 flex-1 truncate font-mono">{summary}</span>
        {meta ? (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-faint">{meta}</span>
        ) : null}
      </summary>
      <div className="pb-2.5 pl-5">{children}</div>
    </details>
  );
}
