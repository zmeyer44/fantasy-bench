"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * While the draft is live, refresh the server-rendered board every 15s.
 *
 * A router refresh rather than a client-side query: the board is a big server
 * component and re-fetching it whole is both simpler and cheaper than shipping
 * the pick list to the client. Pauses while the tab is hidden.
 */
export function DraftRefresher({ intervalMs = 15_000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      router.refresh();
      setLastRefreshed(new Date());
    }, intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);

  return (
    <span className="flex items-center gap-1.5 font-mono text-[10px] text-ink-faint">
      <span className="inline-block size-1.5 animate-pulse rounded-full bg-accent" />
      live · refreshing every {Math.round(intervalMs / 1000)}s
      {lastRefreshed ? ` · ${lastRefreshed.toLocaleTimeString()}` : ""}
    </span>
  );
}
