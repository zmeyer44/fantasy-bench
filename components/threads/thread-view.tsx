"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "convex/react";

import { ThreadMessage } from "@/components/threads/thread-message";
import { TradeCard } from "@/components/trades/trade-card";
import { Badge, Button, Card, CardBody, CardHeader, PageHeader } from "@/components/ui";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { ThreadMessageView } from "@/convex/messaging";
import type { TradeSummary } from "@/convex/trades";
import { formatET } from "@/lib/time";

/** How many messages the first page asks for, and how much "load more" adds. */
const PAGE = 50;

type Entry =
  | { kind: "message"; at: number; message: ThreadMessageView }
  | { kind: "trade"; at: number; trade: TradeSummary };

/**
 * The chat view: messages left/right by team with proposal cards inline, in one
 * chronological stream. Team A (the canonical `teamAId`) is rendered on the
 * right so a conversation always reads the same way.
 *
 * `messaging.getThread` pages its messages oldest-first. Rather than stitching
 * pages together in state (which would freeze the older ones), the view widens
 * the single live page — the whole transcript stays subscribed, so a message an
 * agent sends mid-window appears at the bottom by itself.
 */
export function ThreadView({
  leagueId,
  threadId,
  fairnessFloor,
}: {
  leagueId: string;
  threadId: string;
  fairnessFloor?: number;
}) {
  const [numItems, setNumItems] = useState(PAGE);
  const thread = useQuery(api.messaging.getThread, {
    leagueId: leagueId as Id<"leagues">,
    threadId: threadId as Id<"threads">,
    paginationOpts: { numItems, cursor: null },
  });

  if (thread === undefined) {
    return <p className="py-10 text-center text-sm text-ink-faint">Loading the conversation…</p>;
  }

  const entries: Entry[] = [
    ...thread.messages.page.map((message) => ({
      kind: "message" as const,
      at: message.createdAt,
      message,
    })),
    ...thread.trades.map((trade) => ({ kind: "trade" as const, at: trade.createdAt, trade })),
  ].sort((a, b) => a.at - b.at);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          thread.windowLabel ? `${thread.windowLabel} · week ${thread.weekNo}` : "Direct messages"
        }
        title={`${thread.teamA.name} ↔ ${thread.teamB.name}`}
        description={`${thread.messageCount} messages · ${thread.trades.length} proposal${
          thread.trades.length === 1 ? "" : "s"
        }`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={thread.status === "open" ? "accent" : "neutral"}>{thread.status}</Badge>
            {thread.flaggedCount > 0 ? (
              <Badge tone="danger">{thread.flaggedCount} flagged</Badge>
            ) : null}
            <Link
              href={`/leagues/${leagueId}/threads`}
              className="text-xs text-ink-muted hover:text-accent-strong"
            >
              All threads →
            </Link>
          </div>
        }
      />

      {thread.delayed ? (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-4 py-3">
          <p className="text-sm font-medium text-ink">Delayed reveal</p>
          <p className="mt-0.5 text-xs text-ink-muted">
            This league hides negotiation bodies from non-parties until the negotiation resolves
            or its window closes
            {thread.revealAt ? `, at ${formatET(thread.revealAt, "MMM d HH:mm")} ET` : ""}. The
            proposals themselves stay public.
          </p>
        </div>
      ) : null}

      <Card>
        <CardHeader
          title="Conversation"
          description={`${thread.teamB.name} on the left, ${thread.teamA.name} on the right`}
        />
        <CardBody>
          {entries.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-faint">Nothing said yet.</p>
          ) : (
            <>
              <ul className="space-y-4">
                {entries.map((entry) =>
                  entry.kind === "message" ? (
                    <ThreadMessage
                      key={entry.message.id}
                      leagueId={leagueId}
                      message={entry.message}
                      alignRight={entry.message.senderTeamId === thread.teamA.id}
                    />
                  ) : (
                    <li key={entry.trade.id}>
                      <TradeCard
                        leagueId={leagueId}
                        trade={entry.trade}
                        fairnessFloor={fairnessFloor}
                      />
                    </li>
                  ),
                )}
              </ul>

              {thread.messages.isDone ? null : (
                <div className="mt-4 flex justify-center">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setNumItems((n) => n + PAGE)}
                  >
                    Load more messages
                  </Button>
                </div>
              )}
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
