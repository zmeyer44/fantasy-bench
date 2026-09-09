import Link from "next/link";

import { TeamTag } from "@/components/nfl/team-logo";
import {
  FairnessBadge,
  FlaggedPill,
  StatusBadge,
} from "@/components/trades/fairness-badge";
import { StatusTimeline } from "@/components/trades/status-timeline";
import { TraceLink } from "@/components/trades/trace-link";
import {
  Badge,
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  InfoTip,
} from "@/components/ui";
import type { TradeSummary } from "@/convex/trades";
import { formatET } from "@/lib/time";

/**
 * One proposal in the negotiation feed: both packages side by side, the
 * deterministic fairness score, and links into the thread and the trace.
 */
export function TradeCard({
  leagueId,
  trade,
  fairnessFloor,
}: {
  leagueId: string;
  trade: TradeSummary;
  fairnessFloor?: number;
}) {
  return (
    <Card size="sm">
      <CardHeader className="border-b">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={trade.status} />
          <FairnessBadge
            score={trade.fairnessScore}
            flagged={trade.flagged}
            floor={fairnessFloor}
          />
          <FlaggedPill flagged={trade.flagged} />
          {trade.weekNo !== null ? (
            <Badge variant="outline">Week {trade.weekNo}</Badge>
          ) : null}
        </div>
        <CardAction className="flex items-center gap-3">
          <span className="font-mono text-[10px] tabular-nums text-ink-faint">
            {formatET(trade.createdAt, "MMM d HH:mm")} ET
          </span>
          <TraceLink
            leagueId={leagueId}
            runId={trade.createdByRunId}
            label="proposer trace"
          />
        </CardAction>
      </CardHeader>

      <CardContent className="grid gap-px bg-border px-0 sm:grid-cols-2">
        <Side
          teamName={trade.proposerTeamName}
          direction="sends"
          players={trade.give}
          faab={trade.faab && trade.faab > 0 ? trade.faab : null}
        />
        <Side
          teamName={trade.recipientTeamName}
          direction="sends"
          players={trade.receive}
          faab={trade.faab && trade.faab < 0 ? -trade.faab : null}
        />
      </CardContent>

      <CardFooter className="flex flex-wrap items-center justify-between gap-3">
        <StatusTimeline status={trade.status} orientation="horizontal" />
        <div className="flex items-center gap-4 text-sm">
          {trade.threadId ? (
            <Link
              href={`/leagues/${leagueId}/threads/${trade.threadId}`}
              className="text-muted-foreground transition-colors hover:text-brand-strong"
            >
              Negotiation →
            </Link>
          ) : null}
          <Link
            href={`/leagues/${leagueId}/trades/${trade.id}`}
            className="text-muted-foreground transition-colors hover:text-brand-strong"
          >
            Details →
          </Link>
        </div>
      </CardFooter>
    </Card>
  );
}

function Side({
  teamName,
  direction,
  players,
  faab,
}: {
  teamName: string;
  direction: string;
  players: TradeSummary["give"];
  faab: number | null;
}) {
  return (
    <div className="bg-card px-4 py-3">
      <p className="eyebrow mb-2.5">
        {teamName} {direction}
      </p>
      {players.length === 0 && !faab ? (
        <p className="text-sm text-ink-faint">nothing</p>
      ) : (
        <ul className="space-y-1">
          {players.map((player) => (
            <li key={player.playerId} className="flex items-baseline gap-2">
              <span className="w-8 shrink-0 font-mono text-[10px] text-ink-faint">
                {player.position ?? "—"}
              </span>
              <span className="min-w-0 truncate text-sm text-foreground">
                {player.playerName ?? player.playerId}
              </span>
              <TeamTag team={player.nflTeam} size={14} />
            </li>
          ))}
          {faab ? (
            <li className="flex items-baseline gap-2">
              <span className="w-8 shrink-0 font-mono text-[10px] text-ink-faint">
                $
              </span>
              <span className="inline-flex items-center gap-1.5 text-sm tabular-nums text-foreground">
                ${faab} FAAB
                <InfoTip term="faab" />
              </span>
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}
