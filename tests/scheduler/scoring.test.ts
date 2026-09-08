/**
 * The scoring table (PRD 5.1 presets). Numbers are hand-computed so a change to
 * the table has to be deliberate.
 */
import { describe, expect, it } from "vitest";

import {
  POINTS_ALLOWED_TIERS,
  SCORING_TABLE,
  computeAllPresets,
  computeFantasyPoints,
  inferPosition,
  pointsAllowedScore,
  scoringTableForPreset,
} from "@/lib/services/scoring/points";

describe("QB scoring", () => {
  const stats = { pass_yd: 300, pass_td: 2, pass_int: 1, rush_yd: 20, rush_td: 1, pass_sack: 3 };

  it("is preset-independent", () => {
    // 300*0.04 + 2*4 + 1*-2 + 20*0.1 + 6 = 12 + 8 - 2 + 2 + 6
    const expected = 26;
    expect(computeFantasyPoints(stats, "ppr", { position: "QB" })).toBe(expected);
    expect(computeFantasyPoints(stats, "standard", { position: "QB" })).toBe(expected);
  });

  it("does not confuse a QB's sacks taken with a defense's sacks", () => {
    expect(computeFantasyPoints({ pass_sack: 5 }, "ppr", { position: "QB" })).toBe(0);
  });
});

describe("RB / WR scoring", () => {
  const stats = { rush_yd: 85, rush_td: 1, rec: 5, rec_yd: 40, fum_lost: 1 };

  it("applies the reception value per preset", () => {
    // 8.5 + 6 + 4 - 2 = 16.5 base, plus receptions
    expect(computeFantasyPoints(stats, "ppr", { position: "RB" })).toBe(21.5);
    expect(computeFantasyPoints(stats, "half_ppr", { position: "RB" })).toBe(19);
    expect(computeFantasyPoints(stats, "standard", { position: "RB" })).toBe(16.5);
  });

  it("adds the TE premium only for tight ends", () => {
    const te = { rec: 6, rec_yd: 60 };
    expect(computeFantasyPoints(te, "ppr", { position: "TE" })).toBe(12);
    expect(computeFantasyPoints(te, "ppr", { position: "TE", tePremium: true })).toBe(15);
    expect(computeFantasyPoints(te, "ppr", { position: "WR", tePremium: true })).toBe(12);
  });

  it("counts two-point conversions", () => {
    expect(computeFantasyPoints({ rec_2pt: 1, rush_2pt: 1, pass_2pt: 1 }, "ppr", { position: "RB" })).toBe(6);
  });
});

describe("kicker scoring", () => {
  it("scores FG buckets 3/4/5 plus XPs minus misses", () => {
    const stats = { fgm_20_29: 1, fgm_30_39: 1, fgm_40_49: 1, fgm_50p: 1, xpm: 3, xpmiss: 1 };
    // 3 + 3 + 4 + 5 + 3 - 1
    expect(computeFantasyPoints(stats, "ppr", { position: "K" })).toBe(17);
  });

  it("does not double-count the overlapping 50+ buckets", () => {
    // Sleeper reports both `fgm_50p` (the total) and `fgm_50_59` (a part of it).
    const stats = { fgm_50p: 2, fgm_50_59: 2, xpm: 0 };
    expect(computeFantasyPoints(stats, "ppr", { position: "K" })).toBe(10);
  });

  it("derives short field goals from the total when buckets are missing", () => {
    // fgm 4, of which one 40-49 and one 50+, so two are short.
    expect(computeFantasyPoints({ fgm: 4, fgm_40_49: 1, fgm_50p: 1, fga: 4 }, "ppr", { position: "K" })).toBe(15);
  });

  it("penalizes misses derived from attempts", () => {
    expect(computeFantasyPoints({ fgm: 1, fga: 3, fgm_40_49: 0, xpm: 0 }, "ppr", { position: "K" })).toBe(1);
  });
});

describe("defense scoring", () => {
  it("scores turnovers, sacks, TDs and the points-allowed tier", () => {
    const stats = { sack: 4, int: 2, fum_rec: 1, def_td: 1, safe: 1, pts_allow: 10 };
    // 4 + 4 + 2 + 6 + 2 + 4 (7-13 tier)
    expect(computeFantasyPoints(stats, "ppr", { position: "DEF" })).toBe(22);
  });

  it("reads Sleeper's actual-stat `td` key when `def_td` is absent", () => {
    expect(computeFantasyPoints({ td: 1, pts_allow: 0 }, "ppr", { position: "DEF" })).toBe(16);
  });

  it("applies every points-allowed tier", () => {
    expect(pointsAllowedScore(0)).toBe(10);
    expect(pointsAllowedScore(3)).toBe(7);
    expect(pointsAllowedScore(13)).toBe(4);
    expect(pointsAllowedScore(20)).toBe(1);
    expect(pointsAllowedScore(27)).toBe(0);
    expect(pointsAllowedScore(34)).toBe(-1);
    expect(pointsAllowedScore(52)).toBe(-4);
    expect(POINTS_ALLOWED_TIERS).toHaveLength(7);
  });
});

describe("scoring helpers", () => {
  it("computes all three presets at once", () => {
    const all = computeAllPresets({ rec: 4, rec_yd: 50 }, { position: "WR" });
    expect(all).toEqual({ ppr: 9, half: 7, std: 5 });
  });

  it("infers a position from the stat keys when the feed omits it", () => {
    expect(inferPosition({ pts_allow: 14 })).toBe("DEF");
    expect(inferPosition({ fgm: 2 })).toBe("K");
    expect(inferPosition({ pass_att: 30 })).toBe("QB");
    expect(inferPosition({ rec_tgt: 5 })).toBe("WR");
    expect(inferPosition({})).toBeNull();
  });

  it("exposes the table for the rules page", () => {
    const table = scoringTableForPreset("half_ppr");
    expect(table.find((r) => r.stat === "rec")?.value).toBe(0.5);
    expect(table.find((r) => r.stat === "pass_td")?.value).toBe(4);
    expect(SCORING_TABLE.length).toBeGreaterThan(20);
  });

  it("returns zero rather than throwing on missing stats", () => {
    expect(computeFantasyPoints(null, "ppr")).toBe(0);
    expect(computeFantasyPoints({}, "ppr", { position: "WR" })).toBe(0);
  });
});
