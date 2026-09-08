/**
 * Standings ordering, with no database access.
 *
 * Two orderings exist in the old code and both are kept, because both are
 * observable: `compareStandings` (lib/services/standings) ranks the snapshot and
 * the waiver order; `compareViewRows` (lib/services/views/standings) ranks the
 * standings page. They differ on ties and losses.
 */
export type StandingLike = {
  teamName: string;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
};

/** lib/services/standings: win pct (ties = ½), then PF, then fewer losses, then name. */
export function compareStandings(a: StandingLike, b: StandingLike): number {
  const aPct = a.wins + a.ties * 0.5;
  const bPct = b.wins + b.ties * 0.5;
  if (bPct !== aPct) return bPct - aPct;
  if (b.pointsFor !== a.pointsFor) return b.pointsFor - a.pointsFor;
  if (a.losses !== b.losses) return a.losses - b.losses;
  return a.teamName.localeCompare(b.teamName);
}

/** lib/services/views/standings: wins, then PF, then name. */
export function compareViewRows(a: StandingLike, b: StandingLike): number {
  if (a.wins !== b.wins) return b.wins - a.wins;
  if (a.pointsFor !== b.pointsFor) return b.pointsFor - a.pointsFor;
  return a.teamName.localeCompare(b.teamName);
}

/** Sort in place with `cmp` and stamp 1-based ranks. */
export function rankRows<T extends StandingLike & { rank: number }>(
  rows: T[],
  cmp: (a: StandingLike, b: StandingLike) => number = compareViewRows,
): T[] {
  rows.sort(cmp);
  rows.forEach((row, index) => {
    row.rank = index + 1;
  });
  return rows;
}

/** `W3` / `L2` / `—` from the tail of a week-ordered result list. */
export function streakOf(
  weeks: Array<{ won: boolean; lost: boolean; tied: boolean }>,
): string {
  if (weeks.length === 0) return "—";
  const last = weeks[weeks.length - 1];
  const kind = last.won ? "W" : last.lost ? "L" : "T";
  let count = 0;
  for (let i = weeks.length - 1; i >= 0; i--) {
    const w = weeks[i];
    const k = w.won ? "W" : w.lost ? "L" : "T";
    if (k !== kind) break;
    count++;
  }
  return `${kind}${count}`;
}
