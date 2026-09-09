import { expect, test } from "vitest";
import { pairMatchupSlots } from "./matchup-slots";

test("pairs repeated positions by occurrence without dropping an empty opponent", () => {
  const pairs = pairMatchupSlots(
    [
      { slot: "WR", id: "a-wr" },
      { slot: "RB1", id: "a-rb1" },
      { slot: "RB2", id: "a-rb2" },
    ],
    [
      { slot: "RB", id: "h-rb" },
      { slot: "QB", id: "h-qb" },
      { slot: "WR", id: "h-wr" },
    ],
  );
  expect(pairs.map((pair) => pair.label)).toEqual(["QB", "RB", "RB", "WR"]);
  expect(pairs[0].away).toBeUndefined();
  expect(pairs[1]).toMatchObject({
    away: { id: "a-rb1" },
    home: { id: "h-rb" },
  });
  expect(pairs[2]).toMatchObject({ away: { id: "a-rb2" } });
  expect(pairs[2].home).toBeUndefined();
  expect(pairs[3]).toMatchObject({
    away: { id: "a-wr" },
    home: { id: "h-wr" },
  });
});
