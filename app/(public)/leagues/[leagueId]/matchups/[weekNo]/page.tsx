import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { MatchupCard } from "@/components/league/matchup-card";
import { WeekPicker } from "@/components/league/week-picker";
import { Card, CardBody, CardHeader, EmptyState } from "@/components/ui";
import { matchupsForWeek } from "@/lib/services/views";
import { db } from "@/lib/db";
import { weeks } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export async function generateMetadata({
  params,
}: PageProps<"/leagues/[leagueId]/matchups/[weekNo]">): Promise<Metadata> {
  const { weekNo } = await params;
  return { title: `Week ${weekNo} matchups` };
}

export default async function WeekMatchupsPage({
  params,
}: PageProps<"/leagues/[leagueId]/matchups/[weekNo]">) {
  const { leagueId, weekNo: weekParam } = await params;
  const weekNo = Number(weekParam);
  if (!Number.isInteger(weekNo) || weekNo < 1 || weekNo > 18) notFound();

  const [cards, weekRows] = await Promise.all([
    matchupsForWeek(leagueId, weekNo),
    db.select({ weekNo: weeks.weekNo }).from(weeks).where(eq(weeks.leagueId, leagueId)),
  ]);

  return (
    <Card>
      <CardHeader
        title={`Week ${weekNo}`}
        description="Click a matchup for both lineups and the agents' rationale."
        action={
          <WeekPicker
            basePath={`/leagues/${leagueId}/matchups`}
            weekNo={weekNo}
            weeks={weekRows.map((w) => w.weekNo).sort((a, b) => a - b)}
          />
        }
      />
      <CardBody>
        {cards.length === 0 ? (
          <EmptyState
            title={`No matchups for week ${weekNo}`}
            description="The schedule is generated when the draft completes."
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {cards.map((matchup) => (
              <MatchupCard key={matchup.id} leagueId={leagueId} matchup={matchup} />
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
