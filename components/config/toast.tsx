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
        "fixed bottom-4 right-4 z-50 max-w-sm rounded-md border px-4 py-3 text-sm shadow-lg",
        tone === "success" && "border-accent/40 bg-accent-soft text-accent-strong",
        tone === "error" && "border-danger/40 bg-danger/10 text-danger",
        tone === "info" && "border-line-strong bg-surface text-ink",
      )}
    >
      {message}
    </div>
  );
}
