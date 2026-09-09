import { describe, expect, test } from "vitest";

import {
  chooseDraftPlayer,
  chooseWaiverClaims,
  urgentDraftPosition,
  type RosterEntry,
} from "./mock_model";

function player(
  playerId: string,
  position: RosterEntry["position"],
  projection: number,
): RosterEntry {
  return {
    playerId,
    name: playerId,
    position,
    projection,
    locked: false,
    onByeThisWeek: false,
    injuryStatus: null,
    ownerTeamId: null,
  };
}

describe("mock/scripted waiver strategy", () => {
  test("does not sacrifice the only FLEX-eligible player for a second quarterback", () => {
    const rb = player("drafted-rb", "RB", 24);
    const qb = player("drafted-qb", "QB", 20);
    const claims = chooseWaiverClaims(
      {
        faabRemaining: 100,
        rosterSlots: { FLEX: 1, BENCH: 1 },
        superflex: false,
        roster: [rb, qb],
      },
      [player("free-qb-1", "QB", 22), player("free-qb-2", "QB", 21)],
    );

    expect(claims).toEqual([
      { addPlayerId: "free-qb-1", dropPlayerId: "drafted-qb", bid: 10 },
    ]);
    expect(claims.some((claim) => claim.dropPlayerId === rb.playerId)).toBe(false);
  });

  test("can make two upgrades when both drops preserve starting-slot coverage", () => {
    const claims = chooseWaiverClaims(
      {
        faabRemaining: 100,
        rosterSlots: { QB: 1, FLEX: 1, BENCH: 2 },
        superflex: false,
        roster: [
          player("starter-qb", "QB", 18),
          player("starter-rb", "RB", 17),
          player("bench-wr", "WR", 5),
          player("bench-rb", "RB", 4),
        ],
      },
      [player("free-wr", "WR", 16), player("free-rb", "RB", 15)],
    );

    expect(claims).toHaveLength(2);
    expect(new Set(claims.map((claim) => claim.dropPlayerId))).toEqual(
      new Set(["bench-rb", "bench-wr"]),
    );
  });
});

describe("mock/scripted draft strategy", () => {
  test("fills a compact FLEX starter before adding the higher-projected quarterback", () => {
    const choice = chooseDraftPlayer(
      {
        rosterSlots: { FLEX: 1, BENCH: 1 },
        superflex: false,
        roster: [],
      },
      [player("top-qb", "QB", 30), player("flex-rb", "RB", 20)],
    );

    expect(choice?.playerId).toBe("flex-rb");
  });

  test("returns to projection order after all starting slots are coverable", () => {
    const choice = chooseDraftPlayer(
      {
        rosterSlots: { FLEX: 1, BENCH: 1 },
        superflex: false,
        roster: [player("starter-rb", "RB", 20)],
      },
      [player("top-qb", "QB", 30), player("bench-wr", "WR", 18)],
    );

    expect(choice?.playerId).toBe("top-qb");
  });

  test("narrows the final default-roster searches to missing kicker and defense starters", () => {
    const roster = [
      player("qb", "QB", 20),
      player("rb-1", "RB", 19),
      player("rb-2", "RB", 18),
      player("wr-1", "WR", 17),
      player("wr-2", "WR", 16),
      player("te", "TE", 15),
      player("flex", "RB", 14),
      ...Array.from({ length: 6 }, (_, index) => player(`bench-${index}`, "WR", 10 - index)),
    ];
    const team = {
      rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1, BENCH: 6 },
      roster,
    };

    expect(urgentDraftPosition(team)).toBe("K");
    expect(urgentDraftPosition({ ...team, roster: [...roster, player("k", "K", 7)] })).toBe("DEF");
  });

  test("does not force a low-value position while surplus picks remain", () => {
    expect(
      urgentDraftPosition({
        rosterSlots: { QB: 1, RB: 1, K: 1, DEF: 1, BENCH: 2 },
        roster: [player("qb", "QB", 20), player("rb", "RB", 18)],
      }),
    ).toBeNull();
  });
});
