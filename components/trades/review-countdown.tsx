"use client";

import { useEffect, useState } from "react";

/**
 * Live countdown to the end of a trade's review period. Rendered client-side so
 * the server can stay cacheable and the number stays honest.
 */
/** `endsAt` is epoch ms, the way every Convex read reports a time. */
export function ReviewCountdown({ endsAt }: { endsAt: number }) {
  const [remaining, setRemaining] = useState(() => msUntil(endsAt));

  useEffect(() => {
    const id = setInterval(() => setRemaining(msUntil(endsAt)), 1000);
    return () => clearInterval(id);
  }, [endsAt]);

  if (remaining <= 0) {
    return (
      <span className="font-mono text-sm text-warning">
        review closed — resolving on the next tick
      </span>
    );
  }
  return (
    <span className="font-mono text-sm tabular-nums text-foreground">
      {formatRemaining(remaining)} left to veto
    </span>
  );
}

function msUntil(endsAt: number): number {
  return endsAt - Date.now();
}

function formatRemaining(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
