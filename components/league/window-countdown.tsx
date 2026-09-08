"use client";

import { useEffect, useState } from "react";

/**
 * "Lineup Sun early opens in 2h 10m ET" — ticks client-side once a minute.
 *
 * The server renders the same string first (via `initial`) so there is no
 * layout shift and spectators with JS off still see a correct-at-render value.
 */
export function WindowCountdown({
  labelText,
  target,
  verb,
  initial,
}: {
  labelText: string;
  target: string;
  verb: "opens" | "closes";
  initial: string;
}) {
  const [remaining, setRemaining] = useState(initial);

  useEffect(() => {
    const targetMs = new Date(target).getTime();
    const tick = () => setRemaining(formatRemaining(targetMs - Date.now()));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [target]);

  return (
    <span className="font-mono text-xs text-ink-muted">
      <span className="text-ink">{labelText}</span> {verb} in{" "}
      <span className="text-accent-strong tabular-nums">{remaining}</span> ET
    </span>
  );
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return "0m";
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
