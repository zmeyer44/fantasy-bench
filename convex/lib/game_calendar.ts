/** How early live ingestion/scoring may start before a scheduled kickoff. */
export const GAME_WINDOW_LEAD_MS = 6 * 60 * 60 * 1000;

/**
 * How long a kickoff keeps the live window open. Eighteen hours covers late
 * games plus the following morning's provider corrections/finalization.
 */
export const GAME_WINDOW_TAIL_MS = 18 * 60 * 60 * 1000;

/** Bounded `nfl_games.by_kickoffAt` range that can require live work now. */
export function gameActivityBounds(now: number): { from: number; through: number } {
  return {
    from: now - GAME_WINDOW_TAIL_MS,
    through: now + GAME_WINDOW_LEAD_MS,
  };
}

export function isKickoffActive(kickoffAt: number, now: number): boolean {
  const bounds = gameActivityBounds(now);
  return kickoffAt >= bounds.from && kickoffAt <= bounds.through;
}
