/**
 * Standings ordering, with no database access.
 *
 * Two orderings exist in the old code and both are kept, because both are
 * observable: `compareStandings` ranks the standings snapshot and
 * the waiver order; `compareViewRows` ranks the
 * standings page. They differ on ties and losses.
 */
export type StandingLike = {
  teamName: string;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
};

/** Standings order: win pct (ties = ½), then PF, then fewer losses, then name. */
export function compareStandings(a: StandingLike, b: StandingLike): number {
  const aPct = a.wins + a.ties * 0.5;
  const bPct = b.wins + b.ties * 0.5;
  if (bPct !== aPct) return bPct - aPct;
  if (b.pointsFor !== a.pointsFor) return b.pointsFor - a.pointsFor;
  if (a.losses !== b.losses) return a.losses - b.losses;
  return a.teamName.localeCompare(b.teamName);
}

/** Standings-page order: wins, then PF, then name. */
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

// ------------------------------------------------------------------ schedule

/**
 * Circle-method round robin.
 *
 * With an odd team count one team sits each round (a bye), which the caller sees
 * as "fewer matchups that week". Home/away alternates by round so home games
 * stay balanced across a cycle.
 */
export function roundRobinRounds<T>(teamIds: T[]): Array<Array<[T, T]>> {
  const BYE = "__BYE__" as unknown as T;
  const ids = [...teamIds];
  if (ids.length % 2 === 1) ids.push(BYE);
  const n = ids.length;
  const rounds: Array<Array<[T, T]>> = [];
  // `ids[0]` stays put; the rest rotate one position per round.
  const rotating = ids.slice(1);
  for (let round = 0; round < n - 1; round++) {
    const order = [ids[0], ...rotating];
    const pairs: Array<[T, T]> = [];
    for (let i = 0; i < n / 2; i++) {
      const a = order[i];
      const b = order[n - 1 - i];
      if (a === BYE || b === BYE) continue;
      pairs.push(round % 2 === 0 ? [a, b] : [b, a]);
    }
    rounds.push(pairs);
    rotating.unshift(rotating.pop() as T);
  }
  return rounds;
}

// ------------------------------------------------------------------ playoffs

export type BracketSlot<T> = { weekNo: number; homeTeamId: T; awayTeamId: T };

/**
 * Seed the bracket at `playoffStartWeek`. 6 teams: seeds 1-2 get a bye and enter
 * in round 2. 4 teams: 1v4 / 2v3 then the final. Other sizes fall back to the
 * largest power of two that fits.
 */
export function bracketForSeeds<T>(
  seeds: T[],
  playoffTeams: number,
  playoffStartWeek: number,
): Array<BracketSlot<T>> {
  const field = seeds.slice(0, Math.min(playoffTeams, seeds.length));
  if (field.length < 2) return [];

  if (field.length === 6) {
    return [
      // Round 1 (byes for seeds 1 and 2)
      { weekNo: playoffStartWeek, homeTeamId: field[2], awayTeamId: field[5] },
      { weekNo: playoffStartWeek, homeTeamId: field[3], awayTeamId: field[4] },
    ];
  }
  const size = 2 ** Math.floor(Math.log2(field.length));
  const bracket = field.slice(0, size);
  const slots: Array<BracketSlot<T>> = [];
  for (let i = 0; i < size / 2; i++) {
    slots.push({
      weekNo: playoffStartWeek,
      homeTeamId: bracket[i],
      awayTeamId: bracket[size - 1 - i],
    });
  }
  return slots;
}

/** The winner of a played matchup, or null on a tie / unplayed game. */
export function winnerOf<T>(m: {
  homeTeamId: T;
  awayTeamId: T;
  homeScore?: number | null;
  awayScore?: number | null;
}): T | null {
  const home = m.homeScore ?? 0;
  const away = m.awayScore ?? 0;
  if (home > away) return m.homeTeamId;
  if (away > home) return m.awayTeamId;
  return null;
}
