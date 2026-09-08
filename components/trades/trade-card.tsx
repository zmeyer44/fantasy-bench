import Link from "next/link";

import { FairnessBadge, FlaggedPill, StatusBadge } from "@/components/trades/fairness-badge";
import { StatusTimeline } from "@/components/trades/status-timeline";
import { TraceLink } from "@/components/trades/trace-link";
import { Badge } from "@/components/ui";
import type { TradeSummary } from "@/lib/services/trades";
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
    <article className="rounded-lg border border-line bg-surface">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={trade.status} />
          <FairnessBadge
            score={trade.fairnessScore}
            flagged={trade.flagged}
            floor={fairnessFloor}
          />
          <FlaggedPill flagged={trade.flagged} />
          {trade.weekNo !== null ? <Badge tone="outline">week {trade.weekNo}</Badge> : null}
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] text-ink-faint">
            {formatET(trade.createdAt, "MMM d HH:mm")} ET
          </span>
          <TraceLink leagueId={leagueId} runId={trade.createdByRunId} label="proposer trace" />
        </div>
      </header>

      <div className="grid gap-px bg-line sm:grid-cols-2">
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
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-2.5">
        <StatusTimeline status={trade.status} />
        <div className="flex items-center gap-3 text-xs">
          {trade.threadId ? (
            <Link
              href={`/leagues/${leagueId}/threads/${trade.threadId}`}
              className="text-ink-muted hover:text-accent-strong"
            >
              Negotiation →
            </Link>
          ) : null}
          <Link
            href={`/leagues/${leagueId}/trades/${trade.id}`}
            className="text-ink-muted hover:text-accent-strong"
          >
            Details →
          </Link>
        </div>
      </footer>
    </article>
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
    <div className="bg-surface px-4 py-3">
      <p className="eyebrow mb-2">
        {teamName} {direction}
      </p>
      {players.length === 0 && !faab ? (
        <p className="text-sm text-ink-faint">nothing</p>
      ) : (
        <ul className="space-y-1">
          {players.map((player) => (
            <li key={player.playerId} className="flex items-baseline gap-2">
              <span className="w-8 shrink-0 font-mono text-[10px] uppercase text-ink-faint">
                {player.position ?? "—"}
              </span>
              <span className="min-w-0 truncate text-sm text-ink">
                {player.playerName ?? player.playerId}
              </span>
              {player.nflTeam ? (
                <span className="font-mono text-[10px] text-ink-faint">{player.nflTeam}</span>
              ) : null}
            </li>
          ))}
          {faab ? (
            <li className="flex items-baseline gap-2">
              <span className="w-8 shrink-0 font-mono text-[10px] uppercase text-ink-faint">
                $
              </span>
              <span className="text-sm text-ink">${faab} FAAB</span>
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}
