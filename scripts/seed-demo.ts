/**
 * Demo league seed — the thing everyone opens first.
 *
 *   npm run db:seed-demo
 *
 * Idempotent: it reuses the league at slug `demo-league` and only fills in what
 * is missing, so running it twice does not double-draft anyone. It builds a
 * complete, realistic league end-to-end: players + week-1 projections + the
 * real 2026 schedule, twelve teams with agent configs on `mock/scripted`, a
 * fully automatic best-available snake draft, default lineups, a round-robin
 * schedule, and week-1 windows.
 *
 * Everything works offline: projections and the schedule fall back to fixtures
 * under `scripts/fixtures/` when the network is unavailable.
 */
import { and, count, eq, isNotNull, sql } from "drizzle-orm";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { db, pgClient } from "@/lib/db";
import {
  agentConfigs,
  configVersions,
  draftPicks,
  leagueMembers,
  leagueRules,
  leagues,
  players,
  rosterSlots,
  teams,
  user,
} from "@/lib/db/schema";
import { parseGamesCsv } from "@/lib/providers/nflverse";
import { parseProjections } from "@/lib/providers/sleeper";
import {
  ingestOwnership,
  ingestPlayers,
  ingestProjections,
  ingestSchedule,
} from "@/lib/providers/ingest";
import * as sleeper from "@/lib/providers/sleeper";
import { materializeWindows } from "@/lib/scheduler/materialize";
import {
  bestAvailablePlayerId,
  finalizeDraft,
  nextPick,
  recordDraftPick,
  startDraft,
} from "@/lib/services/draft";
import { createDefaultAgentConfig, createLeague } from "@/lib/services/league";
import { buildSnapshotPayload, takeSnapshot } from "@/lib/services/snapshot";
import type { SnapshotPayload } from "@/lib/snapshot/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECTIONS_FIXTURE = path.join(ROOT, "scripts", "fixtures", "projections.sample.json");
const SCHEDULE_FIXTURE = path.join(ROOT, "scripts", "fixtures", "nflverse-games.2026.csv");
const PLAYERS_FIXTURE = path.join(ROOT, "scripts", "fixtures", "players.sample.json");

const DEMO_SLUG = "demo-league";
const DEMO_EMAIL = "demo@fantasybench.dev";
const DEMO_MODEL = "mock/scripted";
const SEASON = 2026;

/** Twelve owners with opinions. Names show up all over the UI, so make them fun. */
const DEMO_TEAMS: Array<{ name: string; abbreviation: string; persona: string }> = [
  { name: "Regression to the Mean", abbreviation: "RGR", persona: "Believes every hot start is noise and says so, loudly, every single week." },
  { name: "Context Window Closers", abbreviation: "CTX", persona: "Reads every news item twice and still starts the injured guy." },
  { name: "Bayesian Ballers", abbreviation: "BAY", persona: "Updates priors publicly. Posts posterior distributions as trash talk." },
  { name: "Greedy Decoders", abbreviation: "GRD", persona: "Takes the highest-projected option at every slot. No imagination, decent record." },
  { name: "Temperature One", abbreviation: "TMP", persona: "Chaotic. Will start a backup tight end on a hunch and defend it in a 600-word post." },
  { name: "The Overfitters", abbreviation: "OVF", persona: "Drafts entirely on last season's box scores." },
  { name: "Gradient Ascent", abbreviation: "GRA", persona: "Small improvements, every week, forever. Never makes a big trade." },
  { name: "Hallucinated Handcuffs", abbreviation: "HAL", persona: "Rosters three backup running backs and calls it a strategy." },
  { name: "Stop Sequence", abbreviation: "STP", persona: "Sets a lineup in ninety seconds and logs off. Suspiciously effective." },
  { name: "Attention Is All You Need", abbreviation: "ATT", persona: "Reads the whole forum before every decision. Wins the offseason." },
  { name: "Beam Search Party", abbreviation: "BSP", persona: "Explores five trade branches at once and closes none of them." },
  { name: "The Zero Shots", abbreviation: "ZRO", persona: "No context, no skills, pure model. The control group, and they know it." },
];

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- data

async function ensurePlayers(): Promise<number> {
  const existing = await db.select({ n: count() }).from(players);
  const have = Number(existing[0]?.n ?? 0);
  if (have > 200) {
    console.log(`  players: ${have} already loaded`);
    return have;
  }
  const result = await ingestPlayers({ cachePath: ".cache/sleeper-players.json" });
  if (result.written > 0) {
    console.log(`  players: ${result.written} from ${result.source}`);
    return result.written;
  }
  // No cache and no network — the bundled sample is a valid Sleeper payload, so
  // pointing the cache at it reuses the normal write path.
  const fixture = await readJson<sleeper.SleeperRawPlayer[]>(PLAYERS_FIXTURE);
  if (!fixture) throw new Error("No players available (no cache, no network, no fixture)");
  const fallback = await ingestPlayers({ cachePath: PLAYERS_FIXTURE, cacheTtlMs: 0 });
  console.log(`  players: ${fallback.written} from fixture`);
  return fallback.written;
}

async function ensureProjections(): Promise<number> {
  const live = await ingestProjections(SEASON, 1);
  if (live.written > 0) {
    console.log(`  projections: ${live.written} live rows (${live.source})`);
    return live.written;
  }
  const fixture = await readJson<unknown>(PROJECTIONS_FIXTURE);
  if (!fixture) {
    console.log("  projections: none available");
    return 0;
  }
  const rows = parseProjections(fixture, SEASON, 1);
  const result = await ingestProjections(SEASON, 1, { rows });
  console.log(`  projections: ${result.written} fixture rows (${result.skipped} skipped)`);
  return result.written;
}

async function ensureSchedule(): Promise<number> {
  const csv = await fs.readFile(SCHEDULE_FIXTURE, "utf8").catch(() => null);
  const games = csv ? parseGamesCsv(csv, SEASON) : [];
  if (games.length > 0) {
    const result = await ingestSchedule(SEASON, { games });
    console.log(`  schedule: ${result.written} games from fixture`);
    return result.written;
  }
  const result = await ingestSchedule(SEASON, { weeks: [1, 2, 3] });
  console.log(`  schedule: ${result.written} games from providers`);
  return result.written;
}

// ------------------------------------------------------------------ league

async function ensureLeague(demoUserId: string) {
  const existing = await db.query.leagues.findFirst({ where: eq(leagues.slug, DEMO_SLUG) });
  if (existing) {
    console.log(`  league: reusing ${existing.slug} (${existing.status})`);
    return existing;
  }
  const created = await createLeague({
    name: "Demo League",
    commissionerUserId: demoUserId,
    teamCount: DEMO_TEAMS.length,
    season: SEASON,
    scoringPreset: "ppr",
    draftType: "snake",
    isPublic: true,
    // The demo runs entirely on the scripted mock model — no gateway key needed.
    modelAllowlist: [DEMO_MODEL, "anthropic/claude-sonnet-4.5", "openai/gpt-5-mini"],
  });
  // `createLeague` slugifies the name; force the stable demo slug.
  const [league] = await db
    .update(leagues)
    .set({ slug: DEMO_SLUG })
    .where(eq(leagues.id, created.league.id))
    .returning();
  console.log(`  league: created ${league.slug}`);
  return league;
}

async function ensureTeams(leagueId: string, demoUserId: string): Promise<void> {
  const current = await db
    .select()
    .from(teams)
    .where(eq(teams.leagueId, leagueId))
    .orderBy(teams.createdAt, teams.id);

  // `teams.name` is unique per league, so assign only the names nobody has yet.
  const taken = new Set(current.map((t) => t.name));
  const available = DEMO_TEAMS.filter((t) => !taken.has(t.name));

  for (const [i, team] of current.entries()) {
    const isDemoName = DEMO_TEAMS.some((d) => d.name === team.name);
    const demo = isDemoName ? undefined : available.shift();
    const patch = {
      ...(demo ? { name: demo.name, abbreviation: demo.abbreviation } : {}),
      // The demo user owns team 1 so the console has something to edit.
      ...(i === 0 ? { ownerUserId: demoUserId } : {}),
    };
    if (Object.keys(patch).length === 0) continue;
    await db.update(teams).set(patch).where(eq(teams.id, team.id));
  }

  await db
    .insert(leagueMembers)
    .values({ leagueId, userId: demoUserId, role: "commissioner" })
    .onConflictDoNothing();
}

/** Every team runs the scripted mock model so the demo needs no gateway key. */
async function ensureAgentConfigs(leagueId: string): Promise<void> {
  const leagueTeams = await db
    .select()
    .from(teams)
    .where(eq(teams.leagueId, leagueId))
    .orderBy(teams.createdAt, teams.name);

  for (const [i, team] of leagueTeams.entries()) {
    await createDefaultAgentConfig(team.id, db, DEMO_MODEL);
    const config = await db.query.agentConfigs.findFirst({
      where: eq(agentConfigs.teamId, team.id),
    });
    if (!config?.currentVersionId) continue;
    const persona = DEMO_TEAMS[i]?.persona;
    await db
      .update(configVersions)
      .set({
        modelId: DEMO_MODEL,
        ...(persona
          ? {
              contextMd: sql`${configVersions.contextMd} || ${`\n\nTeam personality: ${persona}`}`,
            }
          : {}),
      })
      .where(and(eq(configVersions.id, config.currentVersionId), sql`${configVersions.modelId} <> ${DEMO_MODEL}`));
  }
}

// ------------------------------------------------------------------- draft

/**
 * Run the whole snake draft synchronously with best-available picks. No runs
 * and no windows: `auto = true` on every pick makes it obvious in the UI that
 * the platform, not an agent, made these.
 */
async function runAutomaticDraft(leagueId: string): Promise<number> {
  const made = await db
    .select({ n: count() })
    .from(draftPicks)
    .where(and(eq(draftPicks.leagueId, leagueId), isNotNull(draftPicks.playerId)));
  if (Number(made[0]?.n ?? 0) > 0) {
    console.log(`  draft: already has ${made[0]?.n} picks`);
    return Number(made[0]?.n ?? 0);
  }

  const { rounds, picks } = await startDraft(leagueId, { type: "snake", seed: 20260908 }, db);
  console.log(`  draft: ${rounds} rounds, ${picks} picks`);

  // One snapshot for the whole draft: 180 rebuilds would take minutes.
  const snapshot = await buildSnapshotPayload({ leagueId, weekNo: 1 }, db);

  let drafted = 0;
  for (;;) {
    const pick = await nextPick(leagueId, db);
    if (!pick) break;
    const playerId = await bestAvailablePlayerId(leagueId, pick.teamId, snapshot, db);
    if (!playerId) {
      console.warn(`  draft: no available player for pick ${pick.overallNo}; stopping`);
      break;
    }
    const result = await recordDraftPick(
      {
        leagueId,
        windowId: "",
        teamId: pick.teamId,
        playerId,
        ctx: {
          runId: "",
          stepIndex: 0,
          toolCallId: "",
          configVersionId: null,
          windowId: "",
          weekNo: 1,
        },
        auto: true,
        rationale: "Demo seed: best available by week-1 projection.",
      },
      db,
    );
    if (!result.ok) {
      console.warn(`  draft: pick ${pick.overallNo} rejected: ${result.errors.join("; ")}`);
      break;
    }
    drafted++;
  }
  return drafted;
}

// -------------------------------------------------------------------- main

async function main(): Promise<void> {
  console.log("Seeding the demo league\n");

  const demoUser = await db.query.user.findFirst({ where: eq(user.email, DEMO_EMAIL) });
  if (!demoUser) {
    throw new Error(
      `Demo user ${DEMO_EMAIL} not found. Run \`npm run db:seed\` first — it creates the user through better-auth.`,
    );
  }

  console.log("Data:");
  await ensurePlayers();
  await ensureSchedule();
  await ensureProjections();
  // Ownership is cosmetic (the "% rostered" column); skip silently offline.
  const ownership = await ingestOwnership(SEASON, 1);
  console.log(`  ownership: ${ownership.written} rows`);

  console.log("\nLeague:");
  const league = await ensureLeague(demoUser.id);
  await ensureTeams(league.id, demoUser.id);
  await ensureAgentConfigs(league.id);

  console.log("\nDraft:");
  const picks = await runAutomaticDraft(league.id);
  console.log(`  ${picks} picks made`);

  // Default lineups + schedule + `in_season`.
  const fresh = await db.query.leagues.findFirst({ where: eq(leagues.id, league.id) });
  if (fresh?.status !== "in_season") {
    const snapshot: SnapshotPayload = await buildSnapshotPayload(
      { leagueId: league.id, weekNo: 1 },
      db,
    );
    const result = await finalizeDraft(league.id, snapshot, db);
    console.log(`  default lineups: ${result.lineups}, matchups: ${result.matchups}`);
  } else {
    console.log("  already in season");
  }

  console.log("\nWindows:");
  const materialized = await materializeWindows(league.id, 1, db);
  console.log(`  week 1: ${materialized.created} created, ${materialized.existing} existing`);

  // A snapshot on disk means the league page has something to show immediately.
  const snap = await takeSnapshot({ leagueId: league.id, weekNo: 1 }, db);
  console.log(`  snapshot: ${snap.snapshotId} (${snap.digest.headline})`);

  const rules = await db.query.leagueRules.findFirst({
    where: eq(leagueRules.leagueId, league.id),
  });
  const rosterCount = await db
    .select({ n: count() })
    .from(rosterSlots)
    .innerJoin(teams, eq(teams.id, rosterSlots.teamId))
    .where(eq(teams.leagueId, league.id));

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  console.log(
    [
      "",
      "Done.",
      `  League:   ${league.name} (${DEMO_TEAMS.length} teams, ${rules?.scoringPreset} scoring)`,
      `  Rostered: ${rosterCount[0]?.n ?? 0} players`,
      `  Model:    ${DEMO_MODEL} for every team`,
      `  Login:    ${DEMO_EMAIL} / password1234`,
      "",
      `  ${appUrl}/leagues/${league.id}`,
      "",
    ].join("\n"),
  );
}

main()
  .then(async () => {
    await pgClient.end({ timeout: 5 });
  })
  .catch(async (err) => {
    console.error(err);
    await pgClient.end({ timeout: 5 }).catch(() => {});
    process.exit(1);
  });
