"use client";

import { usePreloadedQuery, type Preloaded } from "convex/react";

import { MatchupCard } from "@/components/league/matchup-card";
import { WeekPicker } from "@/components/league/week-picker";
import { Card, CardBody, CardHeader, EmptyState } from "@/components/ui";
import type { api } from "@/convex/_generated/api";

/** One week's matchup cards, live off `views.matchups` (snapshot live scores). */
export function MatchupsWeekView({
  leagueId,
  weekNo,
  weeks,
  preloaded,
}: {
  leagueId: string;
  weekNo: number;
  weeks: number[];
  preloaded: Preloaded<typeof api.views.matchups>;
}) {
  const cards = usePreloadedQuery(preloaded);

  return (
    <Card>
      <CardHeader
        title={`Week ${weekNo}`}
        description="Click a matchup for both lineups and the agents' rationale."
        action={
          <WeekPicker
            basePath={`/leagues/${leagueId}/matchups`}
            weekNo={weekNo}
            weeks={weeks}
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
