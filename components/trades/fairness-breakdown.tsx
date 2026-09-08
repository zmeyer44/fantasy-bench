import {
  Stat,
  StatStrip,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";
import type { FairnessDetailV1 } from "@/convex/lib/fairness_pure";

/**
 * The published fairness working. Everything here is deterministic; the
 * `narrative`, when present, is the Commissioner Agent's prose and is clearly
 * labelled as commentary rather than input.
 */
export function FairnessBreakdown({
  detail,
  proposerTeamName,
  recipientTeamName,
  teamNameById,
}: {
  detail: FairnessDetailV1;
  proposerTeamName: string;
  recipientTeamName: string;
  teamNameById: Record<string, string>;
}) {
  const items = detail.items ?? [];
  return (
    <div className="space-y-5">
      <StatStrip>
        <Stat label={`${proposerTeamName} receives`} value={fmt(detail.proposerValue)} />
        <Stat label={`${recipientTeamName} receives`} value={fmt(detail.recipientValue)} />
        <Stat label="Fairness" value={detail.score?.toFixed(2) ?? "—"} tone="brand" />
        <Stat label="Floor" value={detail.floor?.toFixed(2) ?? "—"} />
      </StatStrip>

      {items.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Player</TableHead>
              <TableHead>Pos</TableHead>
              <TableHead>Goes to</TableHead>
              <TableHead numeric>ROS proj</TableHead>
              <TableHead numeric>Scarcity</TableHead>
              <TableHead numeric>Roster fit</TableHead>
              <TableHead numeric>Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={`${item.playerId}-${item.toTeamId}`}>
                <TableCell className="font-medium">{item.playerName}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {item.position}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {teamNameById[item.toTeamId] ?? "—"}
                </TableCell>
                <TableCell numeric>{fmt(item.baseRos)}</TableCell>
                <TableCell numeric>×{item.scarcity.toFixed(2)}</TableCell>
                <TableCell numeric>
                  {item.rosterFit > 1 ? `×${item.rosterFit.toFixed(2)}` : "—"}
                </TableCell>
                <TableCell numeric className="font-medium">
                  {fmt(item.value)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}

      {detail.faab ? (
        <p className="text-sm text-muted-foreground">
          FAAB: ${Math.abs(detail.faab)} moves{" "}
          {detail.faab > 0
            ? `${proposerTeamName} → ${recipientTeamName}`
            : `${recipientTeamName} → ${proposerTeamName}`}
          , valued at {fmt(detail.faabPoints)} projected points.
        </p>
      ) : null}

      {detail.notes?.length ? (
        <ul className="space-y-1 text-sm text-muted-foreground">
          {detail.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}

      {detail.narrative ? (
        <div className="border-l-2 border-border pl-3">
          <p className="eyebrow mb-1.5">Commissioner&apos;s note</p>
          <p className="text-sm text-foreground">{detail.narrative}</p>
          <p className="mt-2 text-xs text-ink-faint">
            Commentary only — the score above is computed deterministically.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function fmt(value: number | undefined): string {
  return value === undefined ? "—" : value.toFixed(1);
}
