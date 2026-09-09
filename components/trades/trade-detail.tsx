"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePreloadedQuery, type Preloaded } from "convex/react";

import { FairnessBreakdown } from "@/components/trades/fairness-breakdown";
import {
  FairnessBadge,
  FlaggedPill,
  StatusBadge,
} from "@/components/trades/fairness-badge";
import { ReviewCountdown } from "@/components/trades/review-countdown";
import { StatusTimeline } from "@/components/trades/status-timeline";
import { TradeCard } from "@/components/trades/trade-card";
import { TraceLink } from "@/components/trades/trace-link";
import { VetoPanel } from "@/components/trades/veto-panel";
import { PageHeader } from "@/components/ui";
import type { api } from "@/convex/_generated/api";
import { formatET } from "@/lib/time";

/**
 * One proposal in full: the packages, the event timeline with links into the
 * traces that caused each transition, the fairness working, and — while the
 * trade is under review — the owners' veto panel.
 *
 * `trades.get` is live, so the veto tally and the status move as other owners
 * vote and as the review window closes.
 */
export function TradeDetail({
  leagueId,
  preloaded,
  teamNames,
  fairnessFloor,
  canVote,
}: {
  leagueId: string;
  preloaded: Preloaded<typeof api.trades.get>;
  teamNames: Array<{ id: string; name: string }>;
  fairnessFloor?: number;
  canVote: boolean;
}) {
  const trade = usePreloadedQuery(preloaded);
  const teamNameById = Object.fromEntries(teamNames.map((t) => [t.id, t.name]));

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={`Trade · week ${trade.weekNo ?? "—"}`}
        title={`${trade.proposerTeamName} ↔ ${trade.recipientTeamName}`}
        description={trade.message ?? undefined}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={trade.status} />
            <FairnessBadge
              score={trade.fairnessScore}
              flagged={trade.flagged}
              floor={fairnessFloor}
            />
            <FlaggedPill flagged={trade.flagged} />
          </div>
        }
      />

      <TradeCard
        leagueId={leagueId}
        trade={trade}
        fairnessFloor={fairnessFloor}
      />

      <div className="grid gap-8 lg:grid-cols-3">
        <div className="space-y-8 lg:col-span-2">
          <Section
            title="Fairness"
            note="ROS projection × scarcity × roster fit — deterministic"
          >
            {trade.fairnessDetail ? (
              <FairnessBreakdown
                detail={trade.fairnessDetail}
                proposerTeamName={trade.proposerTeamName}
                recipientTeamName={trade.recipientTeamName}
                teamNameById={teamNameById}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                Fairness is scored when the recipient accepts.
              </p>
            )}
          </Section>

          <Section
            title="Timeline"
            note="every transition, with its trace"
            flush
          >
            <ol>
              {trade.events.map((event) => (
                <li
                  key={event.id}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border py-2.5 last:border-b-0"
                >
                  <span className="w-36 shrink-0 font-mono text-[11px] tabular-nums text-ink-faint">
                    {formatET(event.createdAt, "MMM d HH:mm:ss")} ET
                  </span>
                  <span className="text-sm font-medium text-foreground">
                    {event.type.replace("_", " ")}
                  </span>
                  {event.actorTeamName ? (
                    <span className="text-sm text-muted-foreground">
                      by {event.actorTeamName}
                    </span>
                  ) : (
                    <span className="text-sm text-ink-faint">
                      by the platform
                    </span>
                  )}
                  {event.fromStatus && event.toStatus ? (
                    <span className="font-mono text-[10px] text-ink-faint">
                      {event.fromStatus} → {event.toStatus}
                    </span>
                  ) : null}
                  <span className="ml-auto">
                    <TraceLink
                      leagueId={leagueId}
                      runId={event.runId}
                      stepIndex={event.stepIndex}
                    />
                  </span>
                </li>
              ))}
            </ol>
          </Section>
        </div>

        <div className="space-y-8">
          <Section title="Review">
            <div className="space-y-4">
              <StatusTimeline status={trade.status} />

              {trade.status === "in_review" && trade.reviewEndsAt ? (
                <ReviewCountdown endsAt={trade.reviewEndsAt} />
              ) : trade.resolvedAt ? (
                <p className="font-mono text-xs text-muted-foreground">
                  resolved {formatET(trade.resolvedAt, "MMM d HH:mm")} ET
                </p>
              ) : null}

              {trade.status === "in_review" ? (
                trade.flagged ? (
                  <VetoPanel
                    leagueId={leagueId}
                    tradeId={trade.id}
                    tally={
                      trade.tally ?? {
                        vetoes: 0,
                        approvals: 0,
                        ownerCount: 0,
                        threshold: 1,
                        blocked: false,
                      }
                    }
                    myVote={trade.myVote}
                    canVote={canVote}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    This trade cleared the fairness floor, so it processes
                    automatically when the review period ends. No vote is
                    needed.
                  </p>
                )
              ) : null}
            </div>
          </Section>

          <Section title="Related" flush>
            <div className="space-y-2 py-3 text-sm">
              {trade.threadId ? (
                <Link
                  href={`/leagues/${leagueId}/threads/${trade.threadId}`}
                  className="block text-muted-foreground transition-colors hover:text-brand-strong"
                >
                  Read the negotiation →
                </Link>
              ) : null}
              {trade.parentTradeId ? (
                <Link
                  href={`/leagues/${leagueId}/trades/${trade.parentTradeId}`}
                  className="block text-muted-foreground transition-colors hover:text-brand-strong"
                >
                  ← The offer this counters
                </Link>
              ) : null}
              {trade.counterTradeIds.map((id) => (
                <Link
                  key={id}
                  href={`/leagues/${leagueId}/trades/${id}`}
                  className="block text-muted-foreground transition-colors hover:text-brand-strong"
                >
                  The counter-offer →
                </Link>
              ))}
              <TraceLink
                leagueId={leagueId}
                runId={trade.createdByRunId}
                label="Proposer's run"
                className="block text-sm text-muted-foreground transition-colors hover:text-brand-strong"
              />
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}

/** Section heading + hairline rule. Grouping without another box. */
function Section({
  title,
  note,
  flush = false,
  children,
}: {
  title: string;
  note?: string;
  flush?: boolean;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border pb-2">
        <h2 className="eyebrow text-foreground">{title}</h2>
        {note ? (
          <p className="font-mono text-[10px] text-ink-faint">{note}</p>
        ) : null}
      </div>
      <div className={flush ? undefined : "pt-4"}>{children}</div>
    </section>
  );
}
