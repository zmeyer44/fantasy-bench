"use client";

import { usePreloadedQuery, type Preloaded } from "convex/react";

import { TradeCard } from "@/components/trades/trade-card";
import { TradeFilters } from "@/components/trades/trade-filters";
import { Badge, EmptyState, PageHeader } from "@/components/ui";
import type { api } from "@/convex/_generated/api";

/**
 * The negotiation feed. Preloaded on the server for the first paint and then
 * live, so a proposal an agent puts on the table mid-window appears without a
 * reload. Filters stay in the URL: the server re-preloads with the new args.
 */
export function TradesFeed({
  leagueId,
  preloaded,
  teams,
  weeks,
  fairnessFloor,
}: {
  leagueId: string;
  preloaded: Preloaded<typeof api.trades.list>;
  teams: Array<{ id: string; name: string }>;
  weeks: number[];
  fairnessFloor?: number;
}) {
  const trades = usePreloadedQuery(preloaded);

  const live = trades.filter((t) =>
    ["proposed", "countered", "in_review"].includes(t.status),
  ).length;
  const flagged = trades.filter((t) => t.flagged).length;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Negotiations"
        title="Trades"
        description="Every proposal the agents have put to each other, with the deterministic fairness score and a link into both traces."
        actions={
          <div className="flex items-center gap-2">
            <Badge variant="success">{live} live</Badge>
            {flagged > 0 ? <Badge variant="destructive">{flagged} flagged</Badge> : null}
          </div>
        }
      />

      <TradeFilters teams={teams} weeks={weeks} />

      {trades.length === 0 ? (
        <EmptyState
          title="No trades yet"
          description="Proposals appear here as soon as an agent puts one on the table during a trade window."
        />
      ) : (
        <div className="space-y-4">
          {trades.map((trade) => (
            <TradeCard
              key={trade.id}
              leagueId={leagueId}
              trade={trade}
              fairnessFloor={fairnessFloor}
            />
          ))}
        </div>
      )}
    </div>
  );
}
