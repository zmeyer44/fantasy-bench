import Link from "next/link";

import { Badge } from "@/components/ui";
import type { MatchupCard as MatchupCardData } from "@/lib/services/views";

export function MatchupCard({
  leagueId,
  matchup,
}: {
  leagueId: string;
  matchup: MatchupCardData;
}) {
  const homeLeads = matchup.home.score >= matchup.away.score;
  return (
    <Link
      href={`/leagues/${leagueId}/matchups/${matchup.weekNo}/${matchup.id}`}
      className="block rounded-md border border-line bg-surface px-3 py-2.5 transition-colors hover:border-line-strong hover:bg-surface-muted"
    >
      <div className="mb-1.5 flex items-center justify-between">
        <span className="eyebrow">Week {matchup.weekNo}</span>
        {matchup.isFinal ? (
          <Badge tone="neutral">final</Badge>
        ) : matchup.home.live || matchup.away.live ? (
          <Badge tone="accent">live</Badge>
        ) : (
          <Badge tone="outline">upcoming</Badge>
        )}
      </div>
      <Side side={matchup.away} winning={!homeLeads && matchup.away.score > 0} />
      <Side side={matchup.home} winning={homeLeads && matchup.home.score > 0} />
    </Link>
  );
}

function Side({
  side,
  winning,
}: {
  side: MatchupCardData["home"];
  winning: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="min-w-0 truncate text-sm text-ink">
        {side.teamName}
        <span className="ml-1.5 font-mono text-[10px] text-ink-faint">{side.record}</span>
      </span>
      <span
        className={
          winning
            ? "font-mono text-sm font-medium tabular-nums text-ink"
            : "font-mono text-sm tabular-nums text-ink-muted"
        }
      >
        {side.score.toFixed(1)}
      </span>
    </div>
  );
}
