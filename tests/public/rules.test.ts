import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { leagueRuleChanges, leagueRules, leagues } from "@/lib/db/schema";
import {
  assignOwner,
  ensureJoinCode,
  getLeagueByJoinCode,
  inviteLink,
  joinByCode,
  listRuleChanges,
  renameTeam,
  replaceDeprecatedModel,
  RulesError,
  setBudgets,
  setModelAllowlist,
  startDraft,
  updateLeague,
  updateRules,
} from "@/lib/services/league/rules";
import { db, truncateAll } from "../setup";
import { currentVersion, makeLeague, makeUser, teamsOf } from "./helpers";

beforeAll(async () => {
  await truncateAll();
});

describe("updateRules — immutability + change log", () => {
  it("logs every changed field before the lock", async () => {
    const { league, commissioner } = await makeLeague();

    const result = await updateRules(league.id, commissioner.id, {
      scoringPreset: "half_ppr",
      faabBudget: 200,
    });

    expect(result.changed.sort()).toEqual(["faabBudget", "scoringPreset"]);
    expect(result.rules.scoringPreset).toBe("half_ppr");
    expect(result.rules.faabBudget).toBe(200);

    const changes = await listRuleChanges(league.id);
    const fields = changes.map((c) => c.field);
    expect(fields).toContain("rules.scoringPreset");
    expect(fields).toContain("rules.faabBudget");

    const scoring = changes.find((c) => c.field === "rules.scoringPreset")!;
    expect(scoring.fromValue).toBe("ppr");
    expect(scoring.toValue).toBe("half_ppr");
    expect(scoring.userId).toBe(commissioner.id);
    expect(scoring.userName).toBe("Commish");
  });

  it("does not log a no-op", async () => {
    const { league, commissioner } = await makeLeague();
    const before = await listRuleChanges(league.id);
    const result = await updateRules(league.id, commissioner.id, { faabBudget: 100 });
    expect(result.changed).toEqual([]);
    const after = await listRuleChanges(league.id);
    expect(after).toHaveLength(before.length);
  });

  it("freezes competitive rules once the draft begins, but not budgets or conduct", async () => {
    const { league, commissioner } = await makeLeague();
    await db
      .update(leagueRules)
      .set({ rulesLockedAt: new Date() })
      .where(eq(leagueRules.leagueId, league.id));

    await expect(
      updateRules(league.id, commissioner.id, { scoringPreset: "standard" }),
    ).rejects.toThrow(/locked/i);
    await expect(
      updateRules(league.id, commissioner.id, { faabBudget: 500 }),
    ).rejects.toThrow(/locked/i);

    // Budgets, conduct and the allowlist stay open, and are marked as post-lock.
    const budgets = await updateRules(league.id, commissioner.id, {
      leagueUsdHardCap: 25,
      transparencyMode: "delayed",
      injectionPolicy: "prohibited",
    });
    expect(budgets.changed.sort()).toEqual([
      "injectionPolicy",
      "leagueUsdHardCap",
      "transparencyMode",
    ]);

    const changes = await listRuleChanges(league.id);
    const capChange = changes.find((c) => c.field === "rules.leagueUsdHardCap")!;
    expect(capChange.note).toMatch(/after rules lock/);
  });

  it("rejects playoffs that start before the regular season ends", async () => {
    const { league, commissioner } = await makeLeague();
    await expect(
      updateRules(league.id, commissioner.id, { regularSeasonWeeks: 14, playoffStartWeek: 12 }),
    ).rejects.toThrow(/Playoffs must start/);
  });
});

describe("setModelAllowlist — pinned ids only", () => {
  it("rejects a `latest` alias", async () => {
    const { league, commissioner } = await makeLeague();
    await expect(
      setModelAllowlist(league.id, commissioner.id, ["anthropic/claude-sonnet-latest"]),
    ).rejects.toThrow(/alias|pinned/i);
    await expect(
      setModelAllowlist(league.id, commissioner.id, ["openai/gpt-latest"]),
    ).rejects.toThrow(RulesError);
  });

  it("rejects a model that is not in the catalog", async () => {
    const { league, commissioner } = await makeLeague();
    await expect(
      setModelAllowlist(league.id, commissioner.id, ["acme/does-not-exist"]),
    ).rejects.toThrow(/not a known model/i);
  });

  it("rejects an empty allowlist", async () => {
    const { league, commissioner } = await makeLeague();
    await expect(setModelAllowlist(league.id, commissioner.id, [])).rejects.toThrow(
      /at least one model/i,
    );
  });

  it("accepts pinned catalog ids and mock ids, de-duplicated, and logs the change", async () => {
    const { league, commissioner } = await makeLeague();
    const rules = await setModelAllowlist(league.id, commissioner.id, [
      "anthropic/claude-sonnet-4.5",
      "anthropic/claude-sonnet-4.5",
      "mock/scripted",
    ]);
    expect(rules.modelAllowlist).toEqual(["anthropic/claude-sonnet-4.5", "mock/scripted"]);

    const changes = await listRuleChanges(league.id);
    expect(changes.some((c) => c.field === "rules.modelAllowlist")).toBe(true);
  });
});

describe("setBudgets", () => {
  it("clears a cap when passed null", async () => {
    const { league, commissioner } = await makeLeague();
    await setBudgets(league.id, commissioner.id, { leagueUsdHardCap: 10 });
    const cleared = await setBudgets(league.id, commissioner.id, { leagueUsdHardCap: null });
    expect(cleared.leagueUsdHardCap).toBeNull();
  });
});

describe("replaceDeprecatedModel", () => {
  it("creates a new config version per affected team and logs league-wide", async () => {
    const { league, commissioner, teams: created } = await makeLeague({ teamCount: 8 });

    const before = await currentVersion(created[0].id);
    const fromModelId = before!.modelId;
    const toModelId =
      fromModelId === "anthropic/claude-haiku-4.5"
        ? "anthropic/claude-sonnet-4.5"
        : "anthropic/claude-haiku-4.5";

    const result = await replaceDeprecatedModel(
      league.id,
      commissioner.id,
      fromModelId,
      toModelId,
    );

    expect(result.teamsUpdated).toHaveLength(created.length);
    for (const team of created) {
      const version = await currentVersion(team.id);
      expect(version!.modelId).toBe(toModelId);
      expect(version!.versionNo).toBe(2);
      expect(version!.changeSummary).toBe("commissioner replacement");
      expect(version!.contextMd).toBe(before!.contextMd);
      expect(version!.appliedAt).not.toBeNull();
    }

    const rules = await db.query.leagueRules.findFirst({
      where: eq(leagueRules.leagueId, league.id),
    });
    expect(rules!.modelAllowlist).not.toContain(fromModelId);
    expect(rules!.modelAllowlist).toContain(toModelId);

    const changes = await listRuleChanges(league.id);
    const swap = changes.find((c) => c.field === "models.replaceDeprecated")!;
    expect(swap.fromValue).toBe(fromModelId);
    expect(swap.toValue).toBe(toModelId);
    expect(swap.note).toMatch(/commissioner replacement/);
  });

  it("rejects an unpinned replacement", async () => {
    const { league, commissioner } = await makeLeague();
    await expect(
      replaceDeprecatedModel(
        league.id,
        commissioner.id,
        "anthropic/claude-sonnet-4.5",
        "anthropic/claude-sonnet-latest",
      ),
    ).rejects.toThrow(/alias|pinned/i);
  });

  it("leaves teams on other models alone", async () => {
    const { league, commissioner, teams: created } = await makeLeague({ teamCount: 8 });
    const result = await replaceDeprecatedModel(
      league.id,
      commissioner.id,
      "xai/grok-4",
      "openai/gpt-5-mini",
    );
    expect(result.teamsUpdated).toHaveLength(0);
    const version = await currentVersion(created[0].id);
    expect(version!.versionNo).toBe(1);
  });
});

describe("invite codes", () => {
  it("mints one code and reuses it", async () => {
    const { league } = await makeLeague();
    const first = await ensureJoinCode(league.id);
    const second = await ensureJoinCode(league.id);
    expect(first).toBe(second);
    expect(first).toMatch(/^[A-Z2-9]{8}$/);

    const link = await inviteLink(league.id);
    expect(link.url).toContain(`/leagues/join/${first}`);
  });

  it("joins a league by code and claims a team", async () => {
    const { league, teams: created } = await makeLeague({ teamCount: 8 });
    const { code } = await inviteLink(league.id);
    const owner = await makeUser("Newcomer");

    const joined = await joinByCode(code, owner.id);
    expect(joined.leagueId).toBe(league.id);
    expect(joined.teamId).toBe(created[0].id);

    // Idempotent: joining twice returns the same team, not a second membership.
    const again = await joinByCode(code, owner.id);
    expect(again.teamId).toBe(joined.teamId);

    const claimed = await teamsOf(league.id);
    expect(claimed.filter((t) => t.ownerUserId === owner.id)).toHaveLength(1);
  });

  it("rejects an unknown code", async () => {
    const stranger = await makeUser();
    await expect(joinByCode("NOTACODE", stranger.id)).rejects.toThrow(/not valid/i);
    expect(await getLeagueByJoinCode("NOTACODE")).toBeUndefined();
  });
});

describe("teams", () => {
  it("assigns and unassigns an owner, logging both", async () => {
    const { league, commissioner, teams: created } = await makeLeague();
    const owner = await makeUser("Assigned Owner");

    await assignOwner(created[0].id, owner.id, commissioner.id);
    let rows = await teamsOf(league.id);
    expect(rows.find((t) => t.id === created[0].id)!.ownerUserId).toBe(owner.id);

    await assignOwner(created[0].id, null, commissioner.id);
    rows = await teamsOf(league.id);
    expect(rows.find((t) => t.id === created[0].id)!.ownerUserId).toBeNull();

    const changes = await listRuleChanges(league.id);
    expect(changes.filter((c) => c.field.endsWith(".owner"))).toHaveLength(2);
  });

  it("refuses to give one user two teams in a league", async () => {
    const { commissioner, teams: created } = await makeLeague();
    const owner = await makeUser("Greedy");
    await assignOwner(created[0].id, owner.id, commissioner.id);
    await expect(assignOwner(created[1].id, owner.id, commissioner.id)).rejects.toThrow(
      /already owns/i,
    );
  });

  it("renames a team and rejects a duplicate name", async () => {
    const { commissioner, teams: created } = await makeLeague();
    const renamed = await renameTeam(created[0].id, "The Gradient Descenders", commissioner.id, {
      abbreviation: "GRAD",
    });
    expect(renamed.name).toBe("The Gradient Descenders");
    expect(renamed.abbreviation).toBe("GRAD");

    await expect(
      renameTeam(created[1].id, "The Gradient Descenders", commissioner.id),
    ).rejects.toThrow(/already has that name/i);
  });
});

describe("startDraft", () => {
  it("locks the rules, flips the status, and logs it", async () => {
    const { league, commissioner } = await makeLeague();
    const result = await startDraft(league.id, commissioner.id);
    expect(result.status).toBe("drafting");

    const after = await db.query.leagues.findFirst({ where: eq(leagues.id, league.id) });
    expect(after!.status).toBe("drafting");

    const rules = await db.query.leagueRules.findFirst({
      where: eq(leagueRules.leagueId, league.id),
    });
    expect(rules!.rulesLockedAt).not.toBeNull();

    const changes = await listRuleChanges(league.id);
    expect(changes.some((c) => c.field === "league.status")).toBe(true);

    // Second call is refused, and the rule set is now frozen.
    await expect(startDraft(league.id, commissioner.id)).rejects.toThrow(/already started/i);
    await expect(
      updateRules(league.id, commissioner.id, { superflex: true }),
    ).rejects.toThrow(/locked/i);
  });

  it("freezes the draft format after the draft begins", async () => {
    const { league, commissioner } = await makeLeague();
    await updateLeague(league.id, commissioner.id, { draftType: "auction" });
    await startDraft(league.id, commissioner.id);
    await expect(
      updateLeague(league.id, commissioner.id, { draftType: "snake" }),
    ).rejects.toThrow(/draft format cannot change/i);
  });
});

describe("change log", () => {
  it("is append-only and newest-first", async () => {
    const { league, commissioner } = await makeLeague();
    await updateRules(league.id, commissioner.id, { faabBudget: 150 });
    await updateRules(league.id, commissioner.id, { faabBudget: 175 });

    const rows = await db
      .select()
      .from(leagueRuleChanges)
      .where(eq(leagueRuleChanges.leagueId, league.id));
    expect(rows).toHaveLength(2);

    const listed = await listRuleChanges(league.id);
    expect(listed[0].toValue).toBe(175);
    expect(listed[1].toValue).toBe(150);
  });
});
