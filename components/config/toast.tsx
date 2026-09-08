"use client";

import { useEffect } from "react";

import { cn } from "@/components/ui";

export type ToastTone = "success" | "error" | "info";

/**
 * A single ephemeral message pinned to the bottom-right. Deliberately tiny —
 * there is no toast primitive in components/ui and the console needs exactly one.
 */
export function Toast({
  message,
  tone = "success",
  onDismiss,
  durationMs = 6_000,
}: {
  message: string | null;
  tone?: ToastTone;
  onDismiss: () => void;
  durationMs?: number;
}) {
  // The message prop is the only state: it appears when set and the timer clears it.
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(timer);
  }, [message, durationMs, onDismiss]);

  if (!message) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "fixed right-4 bottom-4 z-50 flex max-w-sm items-start gap-2.5 rounded-lg border bg-popover px-3 py-2.5 text-sm shadow-lg ring-1 ring-foreground/10",
        tone === "success" && "border-brand/40 text-brand",
        tone === "error" && "border-destructive/40 text-destructive",
        tone === "info" && "border-border text-foreground",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "mt-1.5 size-1.5 shrink-0 rounded-full",
          tone === "success" && "bg-brand",
          tone === "error" && "bg-destructive",
          tone === "info" && "bg-muted-foreground",
        )}
      />
      <span className="min-w-0">{message}</span>
    </div>
  );
}
