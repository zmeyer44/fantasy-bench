/**
 * The scoring table and the fantasy-point scorer (PRD §5.1 presets).
 *
 * The table is exported as data, not code, so the public rules page renders
 * exactly what the scorer applies. Keys are Sleeper stat keys
 * (docs/DATA_PROVIDERS.md) — projections and actual stats share one vocabulary,
 * which is why one table scores both.
 *
 * The scorer is position-aware rather than a blind sum over the table: a QB's
 * `pass_sack` is not a DEF's `sack`, and kicker FG buckets overlap (`fgm_50p`
 * is the total that `fgm_50_59` sits inside), so they are reconciled instead of
 * added.
 *
 * Pure: no database, no Convex context. `convex/lib/scoring_pure.ts` re-exports
 * it alongside the slot predicates the Convex scorer needs.
 */

export type ScoringPreset = "ppr" | "half_ppr" | "standard";

export type ScoringRule = {
  /** Sleeper stat key. */
  stat: string;
  label: string;
  /** Points per unit, by preset. */
  points: Record<ScoringPreset, number>;
  group: "passing" | "rushing" | "receiving" | "misc" | "kicking" | "defense";
};

export const RECEPTION_POINTS: Record<ScoringPreset, number> = {
  ppr: 1,
  half_ppr: 0.5,
  standard: 0,
};

/** Extra points per reception for a TE when the league runs TE premium. */
export const TE_PREMIUM_BONUS = 0.5;

const all = (n: number): Record<ScoringPreset, number> => ({ ppr: n, half_ppr: n, standard: n });

export const SCORING_TABLE: readonly ScoringRule[] = [
  // Passing
  { stat: "pass_yd", label: "Passing yard", points: all(0.04), group: "passing" },
  { stat: "pass_td", label: "Passing TD", points: all(4), group: "passing" },
  { stat: "pass_int", label: "Interception thrown", points: all(-2), group: "passing" },
  { stat: "pass_2pt", label: "2-pt conversion (pass)", points: all(2), group: "passing" },
  // Rushing
  { stat: "rush_yd", label: "Rushing yard", points: all(0.1), group: "rushing" },
  { stat: "rush_td", label: "Rushing TD", points: all(6), group: "rushing" },
  { stat: "rush_2pt", label: "2-pt conversion (rush)", points: all(2), group: "rushing" },
  // Receiving
  { stat: "rec", label: "Reception", points: RECEPTION_POINTS, group: "receiving" },
  { stat: "rec_yd", label: "Receiving yard", points: all(0.1), group: "receiving" },
  { stat: "rec_td", label: "Receiving TD", points: all(6), group: "receiving" },
  { stat: "rec_2pt", label: "2-pt conversion (catch)", points: all(2), group: "receiving" },
  // Misc
  { stat: "fum_lost", label: "Fumble lost", points: all(-2), group: "misc" },
  // Kicking
  { stat: "fgm_0_19", label: "FG made 0-19", points: all(3), group: "kicking" },
  { stat: "fgm_20_29", label: "FG made 20-29", points: all(3), group: "kicking" },
  { stat: "fgm_30_39", label: "FG made 30-39", points: all(3), group: "kicking" },
  { stat: "fgm_40_49", label: "FG made 40-49", points: all(4), group: "kicking" },
  { stat: "fgm_50p", label: "FG made 50+", points: all(5), group: "kicking" },
  { stat: "xpm", label: "Extra point made", points: all(1), group: "kicking" },
  { stat: "fgmiss", label: "FG missed", points: all(-1), group: "kicking" },
  { stat: "xpmiss", label: "Extra point missed", points: all(-1), group: "kicking" },
  // Defense / special teams
  { stat: "sack", label: "Sack", points: all(1), group: "defense" },
  { stat: "int", label: "Interception", points: all(2), group: "defense" },
  { stat: "fum_rec", label: "Fumble recovered", points: all(2), group: "defense" },
  { stat: "def_td", label: "Defensive/ST TD", points: all(6), group: "defense" },
  { stat: "safe", label: "Safety", points: all(2), group: "defense" },
  { stat: "blk_kick", label: "Blocked kick", points: all(2), group: "defense" },
] as const;

/** Points allowed tiers for a DEF, highest bucket first. */
export const POINTS_ALLOWED_TIERS: ReadonlyArray<{ max: number; points: number; label: string }> = [
  { max: 0, points: 10, label: "0 points allowed" },
  { max: 6, points: 7, label: "1-6 allowed" },
  { max: 13, points: 4, label: "7-13 allowed" },
  { max: 20, points: 1, label: "14-20 allowed" },
  { max: 27, points: 0, label: "21-27 allowed" },
  { max: 34, points: -1, label: "28-34 allowed" },
  { max: Infinity, points: -4, label: "35+ allowed" },
];

export function pointsAllowedScore(pointsAllowed: number): number {
  for (const tier of POINTS_ALLOWED_TIERS) {
    if (pointsAllowed <= tier.max) return tier.points;
  }
  return -4;
}

/** Aliases the feeds use for the same concept. First hit wins. */
export const STAT_ALIASES: Record<string, string[]> = {
  fgmiss: ["fgmiss", "fgm_miss", "fga_miss"],
  xpmiss: ["xpmiss", "xpm_miss"],
  safe: ["safe", "safety", "def_safe"],
  def_td: ["def_td", "def_st_td", "st_td"],
  fum_rec: ["fum_rec", "def_fum_rec"],
};


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
