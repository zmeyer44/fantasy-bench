/**
 * Fantasy point computation from a Sleeper-style stat map.
 *
 * The same function scores actual stats and projections, because both feeds use
 * the same stat vocabulary (docs/DATA_PROVIDERS.md). It is position-aware rather
 * than a blind sum over the table: a QB's `pass_sack` is not a DEF's `sack`, and
 * kicker FG buckets overlap (`fgm_50p` is the total that `fgm_50_59` sits
 * inside), so they have to be reconciled instead of added.
 */
import {
  RECEPTION_POINTS,
  SCORING_TABLE,
  TE_PREMIUM_BONUS,
  pointsAllowedScore,
  type ScoringPreset,
  type ScoringRule,
} from "./table";

export type { ScoringPreset, ScoringRule };
export {
  SCORING_TABLE,
  RECEPTION_POINTS,
  TE_PREMIUM_BONUS,
  POINTS_ALLOWED_TIERS,
  pointsAllowedScore,
} from "./table";

export type StatMap = Record<string, number | string | null | undefined>;

export type ScoringOptions = {
  tePremium?: boolean;
  position?: string | null;
};

function n(stats: StatMap, ...keys: string[]): number {
  for (const key of keys) {
    const value = stats[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

function has(stats: StatMap, key: string): boolean {
  const value = stats[key];
  return value !== undefined && value !== null && value !== "";
}

/** Round to 2dp the way every fantasy site does, avoiding float dust. */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function kickerPoints(stats: StatMap): number {
  const fg40 = n(stats, "fgm_40_49");
  // `fgm_50p` is the 50+ total; `fgm_50_59` + `fgm_60p` are its parts. Never both.
  const fg50 = has(stats, "fgm_50p")
    ? n(stats, "fgm_50p")
    : n(stats, "fgm_50_59") + n(stats, "fgm_60p");

  const bucketed =
    n(stats, "fgm_0_19") + n(stats, "fgm_20_29") + n(stats, "fgm_30_39");
  // Some vintages only report the total `fgm`; back the short ones out of it.
  const shortFgs =
    bucketed > 0 || !has(stats, "fgm")
      ? bucketed
      : Math.max(0, n(stats, "fgm") - fg40 - fg50);

  const misses =
    n(stats, "fgmiss", "fgm_miss") ||
    Math.max(0, n(stats, "fga") - (shortFgs + fg40 + fg50));

  return 3 * shortFgs + 4 * fg40 + 5 * fg50 + n(stats, "xpm") - misses - n(stats, "xpmiss", "xpm_miss");
}

function defensePoints(stats: StatMap): number {
  // `def_td` on projections; `td` on Sleeper's actual DEF rows.
  const defTd = has(stats, "def_td") ? n(stats, "def_td") : n(stats, "td");
  let points =
    n(stats, "sack") * 1 +
    n(stats, "int") * 2 +
    n(stats, "fum_rec") * 2 +
    defTd * 6 +
    n(stats, "safe", "safety", "def_safe") * 2 +
    n(stats, "blk_kick", "fg_blkd") * 2;
  if (has(stats, "pts_allow")) points += pointsAllowedScore(n(stats, "pts_allow"));
  return points;
}

function offensePoints(stats: StatMap, preset: ScoringPreset, opts: ScoringOptions): number {
  const receptions = n(stats, "rec");
  const perReception =
    RECEPTION_POINTS[preset] +
    (opts.tePremium && (opts.position ?? "").toUpperCase() === "TE" ? TE_PREMIUM_BONUS : 0);

  return (
    n(stats, "pass_yd") * 0.04 +
    n(stats, "pass_td") * 4 +
    n(stats, "pass_int") * -2 +
    n(stats, "pass_2pt") * 2 +
    n(stats, "rush_yd") * 0.1 +
    n(stats, "rush_td") * 6 +
    n(stats, "rush_2pt") * 2 +
    receptions * perReception +
    n(stats, "rec_yd") * 0.1 +
    n(stats, "rec_td") * 6 +
    n(stats, "rec_2pt") * 2 +
    n(stats, "fum_lost") * -2
  );
}

/**
 * Fantasy points for one player-week.
 *
 * `position` selects the rule family. When it is unknown the function infers it
 * from the stat keys present, so a row from a feed that omits position still
 * scores correctly.
 */
export function computeFantasyPoints(
  stats: StatMap | null | undefined,
  preset: ScoringPreset,
  opts: ScoringOptions = {},
): number {
  if (!stats) return 0;
  const position = (opts.position ?? inferPosition(stats) ?? "").toUpperCase();

  if (position === "DEF" || position === "DST") return round2(defensePoints(stats));
  if (position === "K") return round2(kickerPoints(stats));
  return round2(offensePoints(stats, preset, { ...opts, position }));
}

/** Compute all three presets at once — what ingestion stores on every row. */
export function computeAllPresets(
  stats: StatMap | null | undefined,
  opts: ScoringOptions = {},
): { ppr: number; half: number; std: number } {
  return {
    ppr: computeFantasyPoints(stats, "ppr", opts),
    half: computeFantasyPoints(stats, "half_ppr", opts),
    std: computeFantasyPoints(stats, "standard", opts),
  };
}

/** Best-effort position inference from the stat keys a row carries. */
export function inferPosition(stats: StatMap): string | null {
  if (has(stats, "pts_allow") || has(stats, "yds_allow")) return "DEF";
  if (has(stats, "fgm") || has(stats, "xpm") || has(stats, "fga")) return "K";
  if (has(stats, "pass_att") || has(stats, "pass_yd")) return "QB";
  if (has(stats, "rec") || has(stats, "rec_tgt")) return "WR";
  if (has(stats, "rush_att")) return "RB";
  return null;
}

/** Pick the right stored column for a league's preset. */
export function pointsForPreset(
  preset: ScoringPreset,
  row: { ppr?: number | null; half?: number | null; std?: number | null },
): number | null {
  if (preset === "ppr") return row.ppr ?? null;
  if (preset === "half_ppr") return row.half ?? null;
  return row.std ?? null;
}

/** Rules grouped for the public rules page. */
export function scoringTableForPreset(
  preset: ScoringPreset,
): Array<ScoringRule & { value: number }> {
  return SCORING_TABLE.map((rule) => ({ ...rule, value: rule.points[preset] }));
}
