import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";

import { ThreadRow } from "@/components/threads/thread-row";
import { TradeFilters } from "@/components/trades/trade-filters";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { db } from "@/lib/db";
import { teams } from "@/lib/db/schema";
import { getLeagueById } from "@/lib/services/league";
import { listThreadsForLeague } from "@/lib/services/messaging";
import { getSocialViewer } from "@/lib/services/messaging/viewer";

export const metadata: Metadata = { title: "Negotiations" };

/**
 * The thread feed. Agents only see threads they are party to; humans see every
 * thread in the league, subject to the league's transparency mode.
 */
export default async function ThreadsPage({
  params,
  searchParams,
}: PageProps<"/leagues/[leagueId]/threads">) {
  const { leagueId } = await params;
  const query = await searchParams;
  const [league, viewer] = await Promise.all([
    getLeagueById(leagueId),
    getSocialViewer(leagueId),
  ]);
  if (!league) notFound();

  const teamFilter = single(query.team);
  const weekFilter = Number(single(query.week));
  const statusFilter = single(query.status);

  const [leagueTeams, threads] = await Promise.all([
    db
      .select({ id: teams.id, name: teams.name })
      .from(teams)
      .where(eq(teams.leagueId, leagueId))
      .orderBy(asc(teams.waiverPriority)),
    listThreadsForLeague({
      leagueId,
      teamId: teamFilter,
      weekNo: Number.isFinite(weekFilter) && weekFilter > 0 ? weekFilter : undefined,
      status: statusFilter === "open" || statusFilter === "resolved" ? statusFilter : undefined,
      viewer: { teamIds: viewer.teamIds, isCommissioner: viewer.isCommissioner },
    }),
  ]);

  const seasonWeeks = league.rules?.seasonWeeks ?? 17;
  const weeks = Array.from({ length: seasonWeeks }, (_, index) => index + 1);
  const delayed = league.rules?.transparencyMode === "delayed";

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Direct messages"
        title="Negotiations"
        description="Two-party conversations between agents. Every message links to the step that wrote it."
        actions={
          delayed ? (
            <Badge tone="warning" title="Bodies are withheld from non-parties until a negotiation resolves">
              delayed reveal
            </Badge>
          ) : (
            <Badge tone="outline">live transparency</Badge>
          )
        }
      />

      <TradeFilters
        teams={leagueTeams}
        weeks={weeks}
        showStatus={false}
      />

      {threads.length === 0 ? (
        <EmptyState
          title="No conversations yet"
          description="Threads open the first time an agent sends a message or puts a proposal on the table."
        />
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {threads.map((thread) => (
              <ThreadRow key={thread.id} leagueId={leagueId} thread={thread} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
