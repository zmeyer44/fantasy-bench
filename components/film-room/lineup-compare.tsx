import { formatSignedPoints } from "@/components/cost/format";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from "@/components/ui";
import type { api } from "@/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";

/** The lineup-efficiency block of `metrics.filmRoom`. */
export type FilmRoomEfficiency = NonNullable<
  FunctionReturnType<typeof api.metrics.filmRoom>["efficiency"]
>;

type Row = FilmRoomEfficiency["actualSlots"][number];

/**
 * Pair the two lineups slot-for-slot.
 *
 * Duplicate slot labels (`RB`, `RB`, `WR`, `WR`) carry no meaning of their own,
 * so pairing them in raw array order makes an identical pick look like a change.
 * Within each label the rows are ordered by points on both sides first, which
 * lines the shared picks up and leaves the real substitutions on their own rows.
 */
function pairRows(actual: Row[], optimal: Row[]): Array<{ actual: Row | null; optimal: Row | null }> {
  const labels: string[] = [];
  for (const row of actual) if (!labels.includes(row.slot)) labels.push(row.slot);
  for (const row of optimal) if (!labels.includes(row.slot)) labels.push(row.slot);

  const byPoints = (a: Row, b: Row) => b.points - a.points;
  const out: Array<{ actual: Row | null; optimal: Row | null }> = [];

  for (const label of labels) {
    const left = actual.filter((r) => r.slot === label).sort(byPoints);
    const right = optimal.filter((r) => r.slot === label).sort(byPoints);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      out.push({ actual: left[i] ?? null, optimal: right[i] ?? null });
    }
  }
  return out;
}

/** Colour a delta by direction: lime when the agent came out ahead, red when it didn't. */
function deltaClass(delta: number): string {
  if (Math.abs(delta) < 0.05) return "text-ink-faint";
  return delta > 0 ? "text-brand" : "text-destructive";
}

/**
 * Side-by-side starting lineups: what the agent set vs what it should have set.
 *
 * The two halves are the same shape and start on the same row, so a substitution
 * reads as a horizontal jump rather than as two lists to diff by hand. The delta
 * column carries the only colour in the table.
 */
export function LineupCompare({ efficiency }: { efficiency: FilmRoomEfficiency }) {
  const rows = pairRows(efficiency.actualSlots, efficiency.optimalSlots);
  const totalDelta = efficiency.actual - efficiency.optimal;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Slot</TableHead>
          <TableHead>Started</TableHead>
          <TableHead numeric>Pts</TableHead>
          <TableHead className="border-l border-border">Optimal</TableHead>
          <TableHead numeric>Pts</TableHead>
          <TableHead numeric>Δ</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, i) => {
          const differs = (row.actual?.playerId ?? null) !== (row.optimal?.playerId ?? null);
          const actualPts = row.actual?.points ?? 0;
          const optimalPts = row.optimal?.points ?? 0;
          const delta = actualPts - optimalPts;
          return (
            <TableRow key={i}>
              <TableCell className="font-mono text-[11px] tracking-wider text-ink-faint uppercase">
                {row.actual?.slot ?? row.optimal?.slot}
              </TableCell>
              <TableCell>{row.actual?.playerName ?? "—"}</TableCell>
              <TableCell numeric className="font-mono text-xs">
                {actualPts.toFixed(1)}
              </TableCell>
              <TableCell
                className={cn(
                  "border-l border-border",
                  differs ? "font-medium text-foreground" : "text-muted-foreground",
                )}
              >
                {row.optimal?.playerName ?? "—"}
              </TableCell>
              <TableCell numeric className="font-mono text-xs">
                {optimalPts.toFixed(1)}
              </TableCell>
              <TableCell numeric className={cn("font-mono text-xs", deltaClass(delta))}>
                {formatSignedPoints(delta)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell colSpan={2} className="font-medium">
            Total
          </TableCell>
          <TableCell numeric className="font-mono text-xs">
            {efficiency.actual.toFixed(2)}
          </TableCell>
          <TableCell className="border-l border-border" />
          <TableCell numeric className="font-mono text-xs">
            {efficiency.optimal.toFixed(2)}
          </TableCell>
          <TableCell numeric className={cn("font-mono text-xs", deltaClass(totalDelta))}>
            {formatSignedPoints(totalDelta, 2)}
          </TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  );
}
