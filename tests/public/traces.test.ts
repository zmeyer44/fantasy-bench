import { beforeAll, describe, expect, it } from "vitest";

import {
  teamTracesExport,
  trace,
  traceExport,
  traceList,
  traceModelOptions,
} from "@/lib/services/views";
import { truncateAll } from "../setup";
import { makeLeague, makePlayer, makeRun, makeWindow } from "./helpers";

let leagueId: string;
let teamAId: string;
let teamBId: string;
let lineupRunId: string;
let waiverRunId: string;
let mahomesId: string;

beforeAll(async () => {
  await truncateAll();

  const { league, teams: created } = await makeLeague({ teamCount: 8 });
  leagueId = league.id;
  teamAId = created[0].id;
  teamBId = created[1].id;

  const mahomes = await makePlayer("Patrick Mahomes", "QB");
  const kelce = await makePlayer("Travis Kelce", "TE");
  mahomesId = mahomes.id;

  const lineupWindow = await makeWindow(leagueId, {
    type: "lineup",
    label: "lineup_sun_early",
    weekNo: 3,
  });
  const waiverWindow = await makeWindow(leagueId, {
    type: "waiver",
    label: "waiver",
    weekNo: 3,
  });

  // A lineup run whose committed payload names Mahomes by uuid only.
  const lineupRun = await makeRun({
    leagueId,
    windowId: lineupWindow.id,
    teamId: teamAId,
    modelId: "anthropic/claude-sonnet-4.5",
    rationale: "Starting the high-floor build; benching the injured flex.",
    stepText: "I will start the quarterback with the best matchup.",
    toolName: "set_lineup",
    actionPayload: {
      slots: [
        { slot: "QB", playerId: mahomes.id },
        { slot: "TE", playerId: kelce.id },
      ],
    },
  });
  lineupRunId = lineupRun.id;

  // A waiver run on another team, another model, another tool.
  const waiverRun = await makeRun({
    leagueId,
    windowId: waiverWindow.id,
    teamId: teamBId,
    modelId: "openai/gpt-5-mini",
    rationale: "Bidding aggressively on the handcuff.",
    stepText: "Submitting two claims.",
    toolName: "submit_waiver_claims",
    actionPayload: { claims: [{ addPlayerId: kelce.id, bid: 14 }] },
    status: "partial",
  });
  waiverRunId = waiverRun.id;
});

describe("traceList", () => {
  it("returns both runs newest-first with tags resolved", async () => {
    const result = await traceList({ leagueId });
    expect(result.total).toBe(2);
    expect(result.items).toHaveLength(2);

    const lineup = result.items.find((item) => item.id === lineupRunId)!;
    expect(lineup.teamName).toBeTruthy();
    expect(lineup.windowLabelText).toBe("Lineup sun early");
    expect(lineup.modelLabel).toBe("Claude Sonnet 4.5");
    expect(lineup.weekNo).toBe(3);
    expect(lineup.actionCount).toBe(1);
    expect(lineup.costUsd).toBeCloseTo(0.0123, 5);
  });

  it("filters by team, window type, week, status and model", async () => {
    expect((await traceList({ leagueId, teamId: teamBId })).total).toBe(1);
    expect((await traceList({ leagueId, windowType: "waiver" })).total).toBe(1);
    expect((await traceList({ leagueId, weekNo: 3 })).total).toBe(2);
    expect((await traceList({ leagueId, weekNo: 9 })).total).toBe(0);
    expect((await traceList({ leagueId, status: "partial" })).total).toBe(1);
    expect((await traceList({ leagueId, modelId: "openai/gpt-5-mini" })).total).toBe(1);
  });

  it("pages", async () => {
    const page1 = await traceList({ leagueId, page: 1, pageSize: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.pageCount).toBe(2);
    const page2 = await traceList({ leagueId, page: 2, pageSize: 1 });
    expect(page2.items[0].id).not.toBe(page1.items[0].id);
  });
});

describe("trace search", () => {
  it("finds a run by player name, even though only the uuid is in the payload", async () => {
    const result = await traceList({ leagueId, q: "Mahomes" });
    expect(result.items.map((item) => item.id)).toEqual([lineupRunId]);
    expect(result.matchedPlayers.map((p) => p.fullName)).toContain("Patrick Mahomes");
    expect(result.matchedPlayers.map((p) => p.id)).toContain(mahomesId);
  });

  it("finds a run by tool name", async () => {
    const claims = await traceList({ leagueId, q: "submit_waiver_claims" });
    expect(claims.items.map((item) => item.id)).toEqual([waiverRunId]);

    const lineup = await traceList({ leagueId, q: "set_lineup" });
    expect(lineup.items.map((item) => item.id)).toEqual([lineupRunId]);
  });

  it("finds a run by free text in a step or a rationale", async () => {
    expect((await traceList({ leagueId, q: "best matchup" })).items.map((i) => i.id)).toEqual([
      lineupRunId,
    ]);
    expect((await traceList({ leagueId, q: "handcuff" })).items.map((i) => i.id)).toEqual([
      waiverRunId,
    ]);
  });

  it("is case-insensitive and returns nothing for a miss", async () => {
    expect((await traceList({ leagueId, q: "MAHOMES" })).total).toBe(1);
    expect((await traceList({ leagueId, q: "zzz-no-such-thing" })).total).toBe(0);
  });

  it("combines search with a filter", async () => {
    expect((await traceList({ leagueId, q: "Kelce", teamId: teamBId })).total).toBe(1);
    expect((await traceList({ leagueId, q: "Mahomes", teamId: teamBId })).total).toBe(0);
  });
});

describe("trace detail", () => {
  it("returns steps, actions and prompt sections", async () => {
    const detail = await trace(lineupRunId);
    expect(detail).not.toBeNull();
    expect(detail!.steps).toHaveLength(1);
    expect(detail!.steps[0].stepIndex).toBe(0);
    expect(detail!.steps[0].hasValidationError).toBe(false);
    expect(detail!.actions).toHaveLength(1);
    expect(detail!.actions[0].actionType).toBe("set_lineup");
    expect(detail!.window.labelText).toBe("Lineup sun early");
    expect(detail!.league.id).toBe(leagueId);

    // No prompt_sections stored by the runtime → derived from the message array.
    expect(detail!.promptSectionsSource).toBe("derived");
    expect(detail!.promptSections[0].role).toBe("system");
    expect(detail!.promptSections[0].text).toContain("fantasy football");
  });

  it("returns null for an unknown run", async () => {
    expect(await trace("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});

describe("exports", () => {
  it("traceExport is a versioned envelope around the full trace", async () => {
    const payload = await traceExport(lineupRunId);
    expect(payload).not.toBeNull();
    expect(payload!.version).toBe(1);
    expect(payload!.kind).toBe("run");
    expect(typeof payload!.exportedAt).toBe("string");
    expect(payload!.trace.run.id).toBe(lineupRunId);
    expect(payload!.trace.steps).toHaveLength(1);
    expect(payload!.trace.actions).toHaveLength(1);

    // It must survive JSON round-tripping — this is what the route handler ships.
    const round = JSON.parse(JSON.stringify(payload));
    expect(round.trace.run.id).toBe(lineupRunId);
    expect(round.trace.window.labelText).toBe("Lineup sun early");
  });

  it("teamTracesExport carries every run for one team", async () => {
    const payload = await teamTracesExport(teamAId);
    expect(payload!.version).toBe(1);
    expect(payload!.kind).toBe("team");
    expect(payload!.team.leagueId).toBe(leagueId);
    expect(payload!.runCount).toBe(1);
    expect(payload!.truncated).toBe(false);
    expect(payload!.traces[0].run.id).toBe(lineupRunId);
  });

  it("returns null for an unknown team", async () => {
    expect(await teamTracesExport("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});

describe("traceModelOptions", () => {
  it("lists the models that actually ran", async () => {
    const options = await traceModelOptions(leagueId);
    expect(options.map((o) => o.modelId).sort()).toEqual([
      "anthropic/claude-sonnet-4.5",
      "openai/gpt-5-mini",
    ]);
    expect(options.every((o) => o.runCount === 1)).toBe(true);
  });
});
