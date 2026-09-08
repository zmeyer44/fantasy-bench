import type { ReactNode } from "react";

import { cn } from "@/components/ui";

/**
 * A native `<details>` disclosure. No client JS: the trace viewer renders 30
 * steps and every one of them has several of these.
 */
export function Collapsible({
  summary,
  meta,
  children,
  defaultOpen = false,
  tone = "default",
  className,
}: {
  summary: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  tone?: "default" | "error";
  className?: string;
}) {
  return (
    <details
      open={defaultOpen}
      className={cn(
        "group rounded-md border",
        tone === "error" ? "border-danger/40" : "border-line",
        className,
      )}
    >
      <summary
        className={cn(
          "flex cursor-pointer list-none items-center gap-2 rounded-md px-3 py-2 text-xs",
          "hover:bg-surface-muted",
          tone === "error" ? "text-danger" : "text-ink",
        )}
      >
        <span
          aria-hidden
          className="font-mono text-ink-faint transition-transform group-open:rotate-90"
        >
          ›
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{summary}</span>
        {meta ? <span className="shrink-0 font-mono text-[10px] text-ink-faint">{meta}</span> : null}
      </summary>
      <div className="border-t border-line px-3 py-2.5">{children}</div>
    </details>
  );
}
