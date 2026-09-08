import { cn } from "@/components/ui";
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

/** Side-by-side starting lineups: what the agent set vs what it should have set. */
export function LineupCompare({ efficiency }: { efficiency: FilmRoomEfficiency }) {
  const rows = pairRows(efficiency.actualSlots, efficiency.optimalSlots);

  return (
    <table className="w-full border-collapse text-sm">
      <thead className="border-b border-line">
        <tr>
          <th className="eyebrow px-3 py-2 text-left">Slot</th>
          <th className="eyebrow px-3 py-2 text-left">Started</th>
          <th className="eyebrow px-3 py-2 text-right">Pts</th>
          <th className="eyebrow px-3 py-2 text-left">Optimal</th>
          <th className="eyebrow px-3 py-2 text-right">Pts</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {rows.map((row, i) => {
          const differs = (row.actual?.playerId ?? null) !== (row.optimal?.playerId ?? null);
          return (
            <tr key={i} className={differs ? "bg-warning/5" : undefined}>
              <td className="px-3 py-1.5 font-mono text-[11px] text-ink-faint">
                {row.actual?.slot ?? row.optimal?.slot}
              </td>
              <td className="px-3 py-1.5">{row.actual?.playerName ?? "—"}</td>
              <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                {(row.actual?.points ?? 0).toFixed(1)}
              </td>
              <td
                className={cn(
                  "px-3 py-1.5",
                  differs ? "font-medium text-accent-strong" : "text-ink-muted",
                )}
              >
                {row.optimal?.playerName ?? "—"}
              </td>
              <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                {(row.optimal?.points ?? 0).toFixed(1)}
              </td>
            </tr>
          );
        })}
      </tbody>
      <tfoot className="border-t border-line">
        <tr>
          <td className="px-3 py-2 font-medium" colSpan={2}>
            Total
          </td>
          <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums">
            {efficiency.actual.toFixed(2)}
          </td>
          <td />
          <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums text-accent-strong">
            {efficiency.optimal.toFixed(2)}
          </td>
        </tr>
      </tfoot>
    </table>
  );
}
