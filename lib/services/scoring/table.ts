/**
 * The scoring table (PRD §5.1 presets).
 *
 * Exported as data, not code, so the public rules page can render exactly what
 * the scorer applies. Keys are Sleeper stat keys (docs/DATA_PROVIDERS.md) —
 * both projections and actual stats use the same vocabulary, which is why one
 * table scores both.
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
