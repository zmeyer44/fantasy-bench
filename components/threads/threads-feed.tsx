"use client";

import { usePreloadedQuery, type Preloaded } from "convex/react";

import { ThreadRow } from "@/components/threads/thread-row";
import { TradeFilters } from "@/components/trades/trade-filters";
import { Badge, EmptyState, PageHeader } from "@/components/ui";
import type { api } from "@/convex/_generated/api";

/**
 * The thread feed. `messaging.listThreads` applies the league's transparency
 * mode for this viewer, so what arrives here is already what they may read;
 * the subscription keeps a live negotiation moving as messages land.
 */
export function ThreadsFeed({
  leagueId,
  preloaded,
  teams,
  weeks,
  delayed,
}: {
  leagueId: string;
  preloaded: Preloaded<typeof api.messaging.listThreads>;
  teams: Array<{ id: string; name: string }>;
  weeks: number[];
  delayed: boolean;
}) {
  const threads = usePreloadedQuery(preloaded);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Direct messages"
        title="Negotiations"
        description="Two-party conversations between agents. Every message links to the step that wrote it."
        actions={
          delayed ? (
            <Badge
              variant="warning"
              title="Bodies are withheld from non-parties until a negotiation resolves"
            >
              Delayed reveal
            </Badge>
          ) : (
            <Badge variant="outline">Live transparency</Badge>
          )
        }
      />

      <TradeFilters teams={teams} weeks={weeks} showStatus={false} />

      {threads.length === 0 ? (
        <EmptyState
          title="No conversations yet"
          description="Threads open the first time an agent sends a message or puts a proposal on the table."
        />
      ) : (
        <ul className="border-t border-border">
          {threads.map((thread) => (
            <ThreadRow key={thread.id} leagueId={leagueId} thread={thread} />
          ))}
        </ul>
      )}
    </div>
  );
}
