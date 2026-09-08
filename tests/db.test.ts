import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  agentConfigs,
  configVersions,
  leagueMembers,
  leagueRules,
  leagues,
  teams,
  user,
  weeks,
} from "@/lib/db/schema";
import { createDefaultAgentConfig, createLeague, SEASON_WEEKS, slugify } from "@/lib/services/league";
import { db, pgClient, truncateAll } from "./setup";

/**
 * Drizzle wraps driver errors, so the Postgres constraint name lives on
 * `error.cause` (a postgres.js `PostgresError`), not in the thrown message.
 */
async function expectConstraintViolation(
  promise: Promise<unknown>,
  constraint: string,
  code = "23505",
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected ${constraint} violation, but the query succeeded`).toBeDefined();
  const cause = (caught as { cause?: { code?: string; constraint_name?: string } }).cause;
  expect(cause?.code).toBe(code);
  expect(cause?.constraint_name).toBe(constraint);
}

async function makeUser(email = `owner-${randomUUID()}@example.test`) {
  const [row] = await db
    .insert(user)
    .values({ id: randomUUID(), name: "Test Owner", email })
    .returning();
  return row;
}

beforeAll(async () => {
  await truncateAll();
});

describe("migrations", () => {
  it("created every domain table", async () => {
    const rows = await pgClient<{ tablename: string }[]>`
      select tablename from pg_tables where schemaname = 'public'
    `;
    const names = new Set(rows.map((r) => r.tablename));
    for (const expected of [
      "user",
      "session",
      "account",
      "verification",
      "leagues",
      "league_rules",
      "league_members",
      "teams",
      "weeks",
      "matchups",
      "team_results",
      "players",
      "nfl_games",
      "player_stats_weekly",
      "player_projections",
      "news_items",
      "injury_designations",
      "roster_slots",
      "lineups",
      "transactions",
      "agent_configs",
      "config_versions",
      "skills",
      "config_version_skills",
      "windows",
      "snapshots",
      "runs",
      "run_steps",
      "run_actions",
      "waiver_claims",
      "trades",
      "trade_items",
      "trade_events",
      "trade_votes",
      "threads",
      "messages",
      "forum_posts",
      "forum_comments",
      "forum_votes",
      "usage_events",
      "model_prices",
      "budgets",
      "budget_rollups",
      "custom_providers",
    ]) {
      expect(names.has(expected), `missing table ${expected}`).toBe(true);
    }
  });
});

describe("createLeague", () => {
  it("creates rules, commissioner membership, 17 weeks and N teams", async () => {
    const commissioner = await makeUser();
    const { league, rules, teams: created } = await createLeague({
      name: "The Bench League",
      commissionerUserId: commissioner.id,
      teamCount: 10,
      season: 2026,
      scoringPreset: "half_ppr",
    });

    expect(league.slug).toBe("the-bench-league");
    expect(league.status).toBe("setup");
    expect(league.teamCount).toBe(10);

    expect(rules.scoringPreset).toBe("half_ppr");
    expect(rules.seasonWeeks).toBe(SEASON_WEEKS);
    expect(rules.faabBudget).toBe(100);
    expect(rules.contextCharLimit).toBe(8000);
    expect(rules.rosterSlots.QB).toBe(1);
    expect(rules.modelAllowlist.length).toBeGreaterThan(0);
    expect(rules.editLock.unlockDay).toBe("tue");

    const members = await db
      .select()
      .from(leagueMembers)
      .where(eq(leagueMembers.leagueId, league.id));
    expect(members).toHaveLength(1);
    expect(members[0].role).toBe("commissioner");

    const weekRows = await db.select().from(weeks).where(eq(weeks.leagueId, league.id));
    expect(weekRows).toHaveLength(SEASON_WEEKS);
    expect(weekRows.filter((w) => w.isPlayoff)).toHaveLength(3);
    // Week 1 opens on a Tuesday at 06:00 ET.
    const week1 = weekRows.find((w) => w.weekNo === 1)!;
    expect(week1.startsAt.getUTCDay()).toBe(2);

    expect(created).toHaveLength(10);
    expect(created.map((t) => t.name)).toContain("Team 1");
    expect(created.map((t) => t.name)).toContain("Team 10");
    expect(created.every((t) => t.ownerUserId === null)).toBe(true);
    expect(created.every((t) => t.faabRemaining === 100)).toBe(true);

    // Every team gets a default agent config on version 1.
    for (const team of created) {
      const config = await db.query.agentConfigs.findFirst({
        where: eq(agentConfigs.teamId, team.id),
        with: { versions: true },
      });
      expect(config, `no config for ${team.name}`).toBeDefined();
      expect(config!.currentVersionId).not.toBeNull();
      const version = await db.query.configVersions.findFirst({
        where: eq(configVersions.id, config!.currentVersionId!),
      });
      expect(version!.versionNo).toBe(1);
      expect(version!.modelId).toBe(rules.modelAllowlist[0]);
      expect(version!.contextMd.length).toBeGreaterThan(100);
      expect(version!.harness.maxSteps).toBeGreaterThan(0);
    }
  });

  it("de-duplicates slugs", async () => {
    const commissioner = await makeUser();
    const a = await createLeague({ name: "Duplicate Cup", commissionerUserId: commissioner.id });
    const b = await createLeague({ name: "Duplicate Cup", commissionerUserId: commissioner.id });
    expect(a.league.slug).toBe("duplicate-cup");
    expect(b.league.slug).toBe("duplicate-cup-2");
  });

  it("rejects an out-of-range team count", async () => {
    const commissioner = await makeUser();
    await expect(
      createLeague({ name: "Too Small", commissionerUserId: commissioner.id, teamCount: 4 }),
    ).rejects.toThrow(/teamCount/);
  });

  it("slugify strips punctuation", () => {
    expect(slugify("  Zach's  League!! ")).toBe("zachs-league");
  });
});

describe("unique constraints", () => {
  it("rejects a duplicate team name within a league", async () => {
    const commissioner = await makeUser();
    const { league } = await createLeague({
      name: "Constraint League",
      commissionerUserId: commissioner.id,
      teamCount: 8,
    });
    await expectConstraintViolation(
      db.insert(teams).values({
        leagueId: league.id,
        name: "Team 1",
        abbreviation: "DUP",
      }),
      "teams_league_name_unique",
    );
  });

  it("allows the same team name in a different league", async () => {
    const commissioner = await makeUser();
    const other = await createLeague({
      name: "Other League",
      commissionerUserId: commissioner.id,
      teamCount: 8,
    });
    const [row] = await db
      .insert(teams)
      .values({ leagueId: other.league.id, name: "Duplicate Elsewhere", abbreviation: "DE" })
      .returning();
    expect(row.id).toBeTruthy();
  });

  it("rejects a duplicate league slug", async () => {
    const commissioner = await makeUser();
    const { league } = await createLeague({
      name: "Slug Guard",
      commissionerUserId: commissioner.id,
    });
    await expectConstraintViolation(
      db.insert(leagues).values({
        name: "Slug Guard",
        slug: league.slug,
        commissionerUserId: commissioner.id,
        season: 2026,
        teamCount: 12,
      }),
      "leagues_slug_unique",
    );
  });

  it("rejects a second membership for the same user in a league", async () => {
    const commissioner = await makeUser();
    const { league } = await createLeague({
      name: "Member Guard",
      commissionerUserId: commissioner.id,
    });
    await expectConstraintViolation(
      db.insert(leagueMembers).values({
        leagueId: league.id,
        userId: commissioner.id,
        role: "owner",
      }),
      "league_members_league_user_unique",
    );
  });

  it("enforces one league_rules row per league", async () => {
    const commissioner = await makeUser();
    const { league } = await createLeague({
      name: "Rules Guard",
      commissionerUserId: commissioner.id,
    });
    await expectConstraintViolation(
      db.insert(leagueRules).values({ leagueId: league.id }),
      "league_rules_league_id_unique",
    );
    const rows = await db.select().from(leagueRules).where(eq(leagueRules.leagueId, league.id));
    expect(rows).toHaveLength(1);
  });

  it("createDefaultAgentConfig is idempotent", async () => {
    const commissioner = await makeUser();
    const { teams: created } = await createLeague({
      name: "Idempotent League",
      commissionerUserId: commissioner.id,
      teamCount: 8,
    });
    const teamId = created[0].id;
    const first = await createDefaultAgentConfig(teamId);
    const second = await createDefaultAgentConfig(teamId);
    expect(second.config.id).toBe(first.config.id);
    expect(second.version.id).toBe(first.version.id);

    const versions = await db
      .select()
      .from(configVersions)
      .where(and(eq(configVersions.configId, first.config.id), eq(configVersions.versionNo, 1)));
    expect(versions).toHaveLength(1);
  });
});
