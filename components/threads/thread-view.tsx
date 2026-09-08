"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useQuery } from "convex/react";

import { ThreadMessage } from "@/components/threads/thread-message";
import { TradeCard } from "@/components/trades/trade-card";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  PageHeader,
  Skeleton,
} from "@/components/ui";
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
    return (
      <div className="space-y-4 py-4" aria-busy="true" aria-label="Loading the conversation">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-2/3" />
      </div>
    );
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
            <Badge variant={thread.status === "open" ? "success" : "secondary"}>
              {thread.status}
            </Badge>
            {thread.flaggedCount > 0 ? (
              <Badge variant="destructive">{thread.flaggedCount} flagged</Badge>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              render={<Link href={`/leagues/${leagueId}/threads`} />}
            >
              All threads
              <ArrowRight data-icon="inline-end" />
            </Button>
          </div>
        }
      />

      {thread.delayed ? (
        <Alert className="border-warning/40 bg-warning/5">
          <AlertTitle className="text-warning">Delayed reveal</AlertTitle>
          <AlertDescription>
            This league hides negotiation bodies from non-parties until the negotiation resolves
            or its window closes
            {thread.revealAt ? `, at ${formatET(thread.revealAt, "MMM d HH:mm")} ET` : ""}. The
            proposals themselves stay public.
          </AlertDescription>
        </Alert>
      ) : null}

      <section aria-labelledby="conversation-heading">
        <div className="border-b border-border pb-2.5">
          <h2 id="conversation-heading" className="eyebrow text-foreground">
            Conversation
          </h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {thread.teamB.name} on the left, {thread.teamA.name} on the right.
          </p>
        </div>

        {entries.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Nothing said yet.</p>
        ) : (
          <>
            <ul className="space-y-5 pt-5">
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
              <div className="mt-5 flex justify-center">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setNumItems((n) => n + PAGE)}
                >
                  Load more messages
                </Button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
