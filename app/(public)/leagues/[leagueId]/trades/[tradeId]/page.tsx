import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";

import { FairnessBreakdown } from "@/components/trades/fairness-breakdown";
import { FairnessBadge, FlaggedPill, StatusBadge } from "@/components/trades/fairness-badge";
import { ReviewCountdown } from "@/components/trades/review-countdown";
import { StatusTimeline } from "@/components/trades/status-timeline";
import { TradeCard } from "@/components/trades/trade-card";
import { TraceLink } from "@/components/trades/trace-link";
import { VetoPanel } from "@/components/trades/veto-panel";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui";
import { db } from "@/lib/db";
import { teams } from "@/lib/db/schema";
import { getLeagueById } from "@/lib/services/league";
import { getSocialViewer } from "@/lib/services/messaging/viewer";
import { getTrade } from "@/lib/services/trades";
import type { FairnessDetailV1 } from "@/lib/services/trades/fairness";
import { formatET } from "@/lib/time";

export async function generateMetadata({
  params,
}: PageProps<"/leagues/[leagueId]/trades/[tradeId]">): Promise<Metadata> {
  const { tradeId } = await params;
  const trade = await getTrade(tradeId);
  return {
    title: trade ? `${trade.proposerTeamName} ↔ ${trade.recipientTeamName}` : "Trade",
  };
}

/**
 * One proposal in full: the packages, the event timeline with links into the
 * traces that caused each transition, the fairness working, and — while the
 * trade is under review — the owners' veto panel.
 */
export default async function TradeDetailPage({
  params,
}: PageProps<"/leagues/[leagueId]/trades/[tradeId]">) {
  const { leagueId, tradeId } = await params;
  const [league, trade, viewer] = await Promise.all([
    getLeagueById(leagueId),
    getTrade(tradeId),
    getSocialViewer(leagueId),
  ]);
  if (!league || !trade || trade.leagueId !== leagueId) notFound();

  const leagueTeams = await db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(eq(teams.leagueId, leagueId));
  const teamNameById = Object.fromEntries(leagueTeams.map((t) => [t.id, t.name]));

  const myVote = viewer.userId
    ? (trade.votes.find((v) => v.userId === viewer.userId)?.vote ?? null)
    : null;
  const detail = trade.fairnessDetail as FairnessDetailV1 | null;

  return (
    <div className="space-y-6">
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
              floor={league.rules?.fairnessFloor ?? undefined}
            />
            <FlaggedPill flagged={trade.flagged} />
          </div>
        }
      />

      <TradeCard
        leagueId={leagueId}
        trade={trade}
        fairnessFloor={league.rules?.fairnessFloor ?? undefined}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader
              title="Fairness"
              description="Rest-of-season projection × positional scarcity × roster fit. Computed deterministically."
            />
            <CardBody>
              {detail ? (
                <FairnessBreakdown
                  detail={detail}
                  proposerTeamName={trade.proposerTeamName}
                  recipientTeamName={trade.recipientTeamName}
                  teamNameById={teamNameById}
                />
              ) : (
                <p className="text-sm text-ink-muted">
                  Fairness is scored when the recipient accepts.
                </p>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Timeline" description="Every transition, with its trace." />
            <CardBody className="px-0 py-0">
              <ol className="divide-y divide-line">
                {trade.events.map((event) => (
                  <li key={event.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5">
                    <span className="w-36 shrink-0 font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                      {formatET(event.createdAt, "MMM d HH:mm:ss")} ET
                    </span>
                    <span className="text-sm font-medium text-ink">
                      {event.type.replace("_", " ")}
                    </span>
                    {event.actorTeamName ? (
                      <span className="text-xs text-ink-muted">by {event.actorTeamName}</span>
                    ) : (
                      <span className="text-xs text-ink-faint">by the platform</span>
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
            </CardBody>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Review" />
            <CardBody className="space-y-4">
              <StatusTimeline status={trade.status} />

              {trade.status === "in_review" && trade.reviewEndsAt ? (
                <ReviewCountdown endsAt={trade.reviewEndsAt} />
              ) : trade.resolvedAt ? (
                <p className="font-mono text-xs text-ink-muted">
                  resolved {formatET(trade.resolvedAt, "MMM d HH:mm")} ET
                </p>
              ) : null}

              {trade.status === "in_review" ? (
                trade.flagged ? (
                  <VetoPanel
                    leagueId={leagueId}
                    tradeId={trade.id}
                    initialTally={
                      trade.tally ?? {
                        vetoes: 0,
                        approvals: 0,
                        ownerCount: 0,
                        threshold: 1,
                        blocked: false,
                      }
                    }
                    myVote={myVote}
                    canVote={viewer.isOwner}
                  />
                ) : (
                  <p className="text-sm text-ink-muted">
                    This trade cleared the fairness floor, so it processes automatically when
                    the review period ends. No vote is needed.
                  </p>
                )
              ) : null}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Related" />
            <CardBody className="space-y-2 text-sm">
              {trade.threadId ? (
                <Link
                  href={`/leagues/${leagueId}/threads/${trade.threadId}`}
                  className="block text-ink-muted hover:text-accent-strong"
                >
                  Read the negotiation →
                </Link>
              ) : null}
              {trade.parentTradeId ? (
                <Link
                  href={`/leagues/${leagueId}/trades/${trade.parentTradeId}`}
                  className="block text-ink-muted hover:text-accent-strong"
                >
                  ← The offer this counters
                </Link>
              ) : null}
              {trade.counterTradeIds.map((id) => (
                <Link
                  key={id}
                  href={`/leagues/${leagueId}/trades/${id}`}
                  className="block text-ink-muted hover:text-accent-strong"
                >
                  The counter-offer →
                </Link>
              ))}
              <TraceLink
                leagueId={leagueId}
                runId={trade.createdByRunId}
                label="Proposer's run"
                className="block text-ink-muted hover:text-accent-strong"
              />
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
