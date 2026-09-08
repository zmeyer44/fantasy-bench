/**
 * Draft rules, with no database access.
 *
 * The pure half of the draft: the recorded-seed RNG that
 * fixes the draft order, the snake board shape, and the positional sanity check
 * a pick has to survive. Keeping them here means the same functions decide an
 * agent's pick and the platform's auto-pick, and a test can exercise them
 * without a deployment.
 */

/** Total roster capacity = every slot in the league's roster shape. */
export function rosterCapacity(rosterShape: Record<string, number>): number {
  return Object.values(rosterShape).reduce((sum, n) => sum + n, 0);
}

// ------------------------------------------------------------------ random

/** mulberry32 — small, deterministic, and reproducible from a recorded seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(items: T[], seed: number): T[] {
  const rng = seededRandom(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ------------------------------------------------------------- snake board

export type SnakeSlot = { round: number; pickNo: number; overallNo: number; teamIndex: number };

/**
 * The whole snake board as indices into `order`. Even rounds run in reverse,
 * which is the only thing that makes a snake a snake.
 */
export function snakeBoard(teamCount: number, rounds: number): SnakeSlot[] {
  const slots: SnakeSlot[] = [];
  let overall = 1;
  for (let round = 1; round <= rounds; round++) {
    for (let i = 0; i < teamCount; i++) {
      const teamIndex = round % 2 === 1 ? i : teamCount - 1 - i;
      slots.push({ round, pickNo: i + 1, overallNo: overall++, teamIndex });
    }
  }
  return slots;
}

// ---------------------------------------------------------- pick validation

/**
 * Positional sanity for a draft pick (PRD 5.2 "position cap sanity").
 *
 * Two rules, both about not bricking your own roster:
 *  - K and DEF are streaming positions; one of each is enough, two is the cap.
 *  - After this pick you must still have enough picks left to fill every
 *    mandatory starting slot.
 */
export function validatePickPosition(args: {
  position: string;
  currentPositions: string[];
  rosterShape: Record<string, number>;
  picksRemainingAfter: number;
  superflex: boolean;
}): string | null {
  const { position, currentPositions, rosterShape, picksRemainingAfter } = args;
  const after = [...currentPositions, position];
  const countOf = (pos: string) => after.filter((p) => p === pos).length;

  for (const streaming of ["K", "DEF"]) {
    const cap = Math.max(1, rosterShape[streaming] ?? 1) + 1;
    if (countOf(streaming) > cap) {
      return `You already have ${cap} ${streaming}${cap > 1 ? "s" : ""}; drafting another wastes a roster spot.`;
    }
  }

  // Mandatory single-position starters that still need a body.
  let stillNeeded = 0;
  for (const [slot, required] of Object.entries(rosterShape)) {
    const upper = slot.toUpperCase();
    if (upper === "BENCH" || upper === "FLEX" || upper === "SUPERFLEX") continue;
    stillNeeded += Math.max(0, required - countOf(upper));
  }
  if (stillNeeded > picksRemainingAfter) {
    return `Taking another ${position} leaves you unable to fill ${stillNeeded} required starting slot(s) with ${picksRemainingAfter} pick(s) remaining.`;
  }
  return null;
}

// ------------------------------------------------------------ auction ties

export type BidLike = { teamId: string; amount: number };

export type LotResolution = {
  winner: BidLike | null;
  price: number | null;
  tiebreak: Record<string, unknown>;
};

/**
 * Sealed-bid resolution: highest bid wins; ties break on the smallest current
 * roster, then on a seeded random that is recorded on the lot so the trace can
 * show how it broke (PRD 5.2).
 */
export function resolveSealedBids(args: {
  bids: BidLike[];
  lotNo: number;
  rosterSizeByTeam: Record<string, number>;
}): LotResolution {
  const { bids, lotNo, rosterSizeByTeam } = args;
  if (bids.length === 0) return { winner: null, price: null, tiebreak: {} };

  const top = Math.max(...bids.map((b) => b.amount));
  const tied = bids.filter((b) => b.amount === top);
  const tiebreak: Record<string, unknown> = { topBid: top, tiedTeams: tied.map((t) => t.teamId) };
  let winner = tied[0];

  if (tied.length > 1) {
    const sizeOf = (teamId: string) => rosterSizeByTeam[teamId] ?? 0;
    const ranked = [...tied].sort((a, b) => sizeOf(a.teamId) - sizeOf(b.teamId));
    const smallest = sizeOf(ranked[0].teamId);
    const stillTied = ranked.filter((t) => sizeOf(t.teamId) === smallest);
    if (stillTied.length > 1) {
      const seed = lotNo * 7919 + top;
      const pick = Math.floor(seededRandom(seed)() * stillTied.length);
      winner = stillTied[pick];
      tiebreak.rule = "seeded_random";
      tiebreak.seed = seed;
    } else {
      winner = ranked[0];
      tiebreak.rule = "lowest_roster_value";
    }
  }

  return { winner, price: winner.amount, tiebreak };
}
