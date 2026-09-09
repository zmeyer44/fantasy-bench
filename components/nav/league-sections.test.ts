import { expect, test } from "vitest";

import { flattenLeagueNav, leagueIdFromPathname, leagueNavEntries } from "./league-sections";

const ctx = { leagueId: "L1", isCommissioner: false, myTeamId: "T9" };

test("folds the competition and paper-trail pages into two groups", () => {
  const entries = leagueNavEntries(ctx, "/leagues/L1");
  expect(entries.map((e) => e.label)).toEqual([
    "Home", "My Team", "League", "Players", "Trades", "Commons", "More",
  ]);
  const league = entries.find((e) => e.label === "League");
  expect(league?.kind === "group" && league.items.map((i) => i.label)).toEqual([
    "Matchups", "Standings", "Teams", "Draft",
  ]);
  const more = entries.find((e) => e.label === "More");
  expect(more?.kind === "group" && more.items.map((i) => i.label)).toEqual(["Traces", "Cost"]);
});

test("offers Settings to commissioners only", () => {
  const entries = leagueNavEntries({ ...ctx, isCommissioner: true }, "/leagues/L1");
  const more = entries.find((e) => e.label === "More");
  expect(more?.kind === "group" && more.items.map((i) => i.label)).toEqual([
    "Traces", "Cost", "Settings",
  ]);
});

test("omits My Team for spectators", () => {
  const entries = leagueNavEntries({ ...ctx, myTeamId: null }, "/leagues/L1");
  expect(entries.map((e) => e.label)).not.toContain("My Team");
});

test("the viewer's own team page activates My Team, not Teams", () => {
  const entries = leagueNavEntries(ctx, "/leagues/L1/teams/T9/config");
  const active = flattenLeagueNav(entries).filter((l) => l.active).map((l) => l.label);
  expect(active).toEqual(["My Team"]);

  const other = leagueNavEntries(ctx, "/leagues/L1/teams/T2");
  expect(flattenLeagueNav(other).filter((l) => l.active).map((l) => l.label)).toEqual(["Teams"]);
  expect(other.find((e) => e.label === "League")?.active).toBe(true);
});

test("Home is exact; a group is active when any child is", () => {
  const entries = leagueNavEntries(ctx, "/leagues/L1/matchups/3/m1");
  expect(entries.find((e) => e.label === "Home")?.active).toBe(false);
  expect(entries.find((e) => e.label === "League")?.active).toBe(true);
  expect(entries.find((e) => e.label === "More")?.active).toBe(false);
});

test("reads the league id out of the pathname, ignoring the invite flow", () => {
  expect(leagueIdFromPathname("/leagues/abc/traces/r1")).toBe("abc");
  expect(leagueIdFromPathname("/leagues/abc")).toBe("abc");
  expect(leagueIdFromPathname("/leagues")).toBeNull();
  expect(leagueIdFromPathname("/leagues/join/CODE")).toBeNull();
  expect(leagueIdFromPathname("/skills/foo")).toBeNull();
});
