import { TeamAvatar } from "@/components/league/identity";
import Link from "next/link";

import {
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";
import type { api } from "@/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";

export type StandingsRow = FunctionReturnType<
  typeof api.views.standings
>[number];

/**
 * The league table. Numeric columns are right-aligned on both the head and the
 * cell (`numeric`), rank is monospaced, and the table spans its section.
 */
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
      <TableHeader>
        <TableRow>
          <TableHead numeric className="w-10">
            #
          </TableHead>
          <TableHead>Team</TableHead>
          <TableHead>Record</TableHead>
          <TableHead numeric>PF</TableHead>
          {compact ? null : <TableHead numeric>PA</TableHead>}
          {compact ? null : <TableHead>Streak</TableHead>}
          {compact ? null : <TableHead>Model</TableHead>}
          {compact ? null : <TableHead numeric>Karma</TableHead>}
          {compact ? null : <TableHead numeric>FAAB</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.teamId}>
            <TableCell numeric className="font-mono text-xs text-ink-faint">
              {row.rank}
            </TableCell>
            <TableCell className="font-medium">
              <Link
                href={`/leagues/${leagueId}/teams/${row.teamId}`}
                className="inline-flex items-center gap-2 hover:text-brand-strong"
              >
                <TeamAvatar
                  name={row.teamName}
                  teamId={row.teamId}
                  avatarUrl={row.avatarUrl}
                  avatarTemplate={row.avatarTemplate}
                  size={28}
                />
                {row.teamName}
              </Link>
              <span className="ml-2 font-mono text-[10px] text-ink-faint">
                {row.abbreviation}
              </span>
            </TableCell>
            <TableCell className="font-mono text-xs tabular-nums">
              {row.wins}-{row.losses}
              {row.ties ? `-${row.ties}` : ""}
            </TableCell>
            <TableCell numeric className="font-mono text-xs">
              {row.pointsFor.toFixed(1)}
            </TableCell>
            {compact ? null : (
              <TableCell
                numeric
                className="font-mono text-xs text-muted-foreground"
              >
                {row.pointsAgainst.toFixed(1)}
              </TableCell>
            )}
            {compact ? null : (
              <TableCell className="font-mono text-xs text-muted-foreground">
                {row.streak}
              </TableCell>
            )}
            {compact ? null : (
              <TableCell>
                {row.modelId ? (
                  <Badge variant="outline" title={row.modelId}>
                    {shortModel(row.modelId)}
                  </Badge>
                ) : (
                  <span className="text-xs text-ink-faint">—</span>
                )}
              </TableCell>
            )}
            {compact ? null : (
              <TableCell numeric className="font-mono text-xs">
                {row.karma}
              </TableCell>
            )}
            {compact ? null : (
              <TableCell numeric className="font-mono text-xs">
                ${row.faabRemaining}
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** `anthropic/claude-sonnet-4.5` → `claude-sonnet-4.5`. */
export function shortModel(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash === -1 ? modelId : modelId.slice(slash + 1);
}
