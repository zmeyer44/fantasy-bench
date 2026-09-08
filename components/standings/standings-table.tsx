import Link from "next/link";

import { Badge, TBody, TD, TH, THead, TR, Table } from "@/components/ui";
import type { StandingsRow } from "@/lib/services/views";

export function StandingsTable({
  leagueId,
  rows,
  compact = false,
}: {
  leagueId: string;
  rows: StandingsRow[];
  compact?: boolean;
}) {
  return (
    <Table>
      <THead>
        <TR>
          <TH numeric>#</TH>
          <TH>Team</TH>
          <TH>Record</TH>
          <TH numeric>PF</TH>
          {compact ? null : <TH numeric>PA</TH>}
          {compact ? null : <TH>Streak</TH>}
          {compact ? null : <TH>Model</TH>}
          {compact ? null : <TH numeric>Karma</TH>}
          {compact ? null : <TH numeric>FAAB</TH>}
        </TR>
      </THead>
      <TBody>
        {rows.map((row) => (
          <TR key={row.teamId}>
            <TD numeric className="font-mono text-xs text-ink-faint">
              {row.rank}
            </TD>
            <TD className="font-medium">
              <Link
                href={`/leagues/${leagueId}/teams/${row.teamId}`}
                className="hover:text-accent-strong"
              >
                {row.teamName}
              </Link>
              <span className="ml-2 font-mono text-[10px] text-ink-faint">
                {row.abbreviation}
              </span>
            </TD>
            <TD className="font-mono text-xs tabular-nums">
              {row.wins}-{row.losses}
              {row.ties ? `-${row.ties}` : ""}
            </TD>
            <TD numeric className="font-mono text-xs">
              {row.pointsFor.toFixed(1)}
            </TD>
            {compact ? null : (
              <TD numeric className="font-mono text-xs text-ink-muted">
                {row.pointsAgainst.toFixed(1)}
              </TD>
            )}
            {compact ? null : (
              <TD className="font-mono text-xs text-ink-muted">{row.streak}</TD>
            )}
            {compact ? null : (
              <TD>
                {row.modelId ? (
                  <Badge tone="outline" title={row.modelId}>
                    {shortModel(row.modelId)}
                  </Badge>
                ) : (
                  <span className="text-xs text-ink-faint">—</span>
                )}
              </TD>
            )}
            {compact ? null : (
              <TD numeric className="font-mono text-xs">
                {row.karma}
              </TD>
            )}
            {compact ? null : (
              <TD numeric className="font-mono text-xs">
                ${row.faabRemaining}
              </TD>
            )}
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

/** `anthropic/claude-sonnet-4.5` → `claude-sonnet-4.5`. */
export function shortModel(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash === -1 ? modelId : modelId.slice(slash + 1);
}
