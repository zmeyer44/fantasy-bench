import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";

import { TradeCard } from "@/components/trades/trade-card";
import { TradeFilters } from "@/components/trades/trade-filters";
import { Badge, EmptyState, PageHeader } from "@/components/ui";
import { db } from "@/lib/db";
import { teams } from "@/lib/db/schema";
import { getLeagueById } from "@/lib/services/league";
import { listTradesForLeague } from "@/lib/services/trades";
import type { TradeStatus } from "@/lib/db/types";

export const metadata: Metadata = { title: "Trades" };

const STATUSES = new Set([
  "proposed",
  "countered",
  "accepted",
  "rejected",
  "expired",
  "in_review",
  "vetoed",
  "completed",
  "cancelled",
]);

/**
 * The negotiation feed (PRD 5.6): every proposal in the league, filterable by
 * team, week and status. Filters live in the query string so the page stays a
 * Server Component and a filtered view is shareable.
 */
export default async function TradesPage({
  params,
  searchParams,
}: PageProps<"/leagues/[leagueId]/trades">) {
  const { leagueId } = await params;
  const query = await searchParams;
  const league = await getLeagueById(leagueId);
  if (!league) notFound();

  const teamFilter = single(query.team);
  const weekFilter = Number(single(query.week));
  const statusFilter = single(query.status);

  const [leagueTeams, trades] = await Promise.all([
    db
      .select({ id: teams.id, name: teams.name })
      .from(teams)
      .where(eq(teams.leagueId, leagueId))
      .orderBy(asc(teams.waiverPriority)),
    listTradesForLeague({
      leagueId,
      teamId: teamFilter,
      weekNo: Number.isFinite(weekFilter) && weekFilter > 0 ? weekFilter : undefined,
      status:
        statusFilter && STATUSES.has(statusFilter)
          ? (statusFilter as TradeStatus)
          : undefined,
      limit: 100,
    }),
  ]);

  const seasonWeeks = league.rules?.seasonWeeks ?? 17;
  const weeks = Array.from({ length: seasonWeeks }, (_, index) => index + 1);
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
            <Badge tone="accent">{live} live</Badge>
            {flagged > 0 ? <Badge tone="danger">{flagged} flagged</Badge> : null}
          </div>
        }
      />

      <TradeFilters teams={leagueTeams} weeks={weeks} />

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
              fairnessFloor={league.rules?.fairnessFloor ?? undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
