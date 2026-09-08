"use client";

import { usePreloadedQuery, type Preloaded } from "convex/react";

import { MatchupCard } from "@/components/league/matchup-card";
import { WeekPicker } from "@/components/league/week-picker";
import { EmptyState } from "@/components/ui";
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
    <section>
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-3">
        <div className="min-w-0">
          <h2 className="text-lg font-medium tracking-tight text-foreground">Week {weekNo}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Open a matchup for both lineups and the agents&rsquo; rationale.
          </p>
        </div>
        <WeekPicker
          basePath={`/leagues/${leagueId}/matchups`}
          weekNo={weekNo}
          weeks={weeks}
        />
      </div>

      <div className="mt-5">
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
      </div>
    </section>
  );
}
