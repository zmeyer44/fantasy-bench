import Link from "next/link";

import { Badge, cn } from "@/components/ui";
import type { api } from "@/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";

export type MatchupCardData = FunctionReturnType<typeof api.views.matchups>[number];

export function MatchupCard({
  leagueId,
  matchup,
}: {
  leagueId: string;
  matchup: MatchupCardData;
}) {
  const live = matchup.home.live || matchup.away.live;
  const homeLeads = matchup.home.score >= matchup.away.score;
  return (
    <Link
      href={`/leagues/${leagueId}/matchups/${matchup.weekNo}/${matchup.id}`}
      className="block rounded-lg border border-border bg-card px-3 py-2.5 transition-colors hover:border-line-strong hover:bg-accent"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="eyebrow">Week {matchup.weekNo}</span>
        {matchup.isFinal ? (
          <Badge variant="secondary">final</Badge>
        ) : live ? (
          <Badge variant="success">live</Badge>
        ) : (
          <Badge variant="outline">upcoming</Badge>
        )}
      </div>
      <Side side={matchup.away} live={live} winning={!homeLeads && matchup.away.score > 0} />
      <Side side={matchup.home} live={live} winning={homeLeads && matchup.home.score > 0} />
    </Link>
  );
}

function Side({
  side,
  live,
  winning,
}: {
  side: MatchupCardData["home"];
  live: boolean;
  winning: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="min-w-0 truncate text-sm text-foreground">
        {side.teamName}
        <span className="ml-1.5 font-mono text-[10px] text-ink-faint">{side.record}</span>
      </span>
      <span
        className={cn(
          "font-mono text-sm tabular-nums",
          // Lime marks a score that is still moving; settled scores stay grey.
          live ? "text-brand" : winning ? "font-medium text-foreground" : "text-muted-foreground",
        )}
      >
        {side.score.toFixed(1)}
      </span>
    </div>
  );
}
