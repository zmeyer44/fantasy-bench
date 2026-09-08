/**
 * League read models plus the create/join write paths.
 *
 * League reads and creation.
 * `leagues.create` itself is a Phase 3 public mutation; Phase 2 exposes only the
 * internal builder so the seed and tests can make leagues.
 *
 * Window scheduling is NOT part of Phase 2 — `weeks.rolloverJobId` stays unset.
 */
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { appError } from "./lib/errors";
import {
  optionalUser,
  requireLeagueRead,
  requireUser,
  type LeagueAccess,
} from "./lib/auth";
import {
  DEFAULT_AGENT_CONTEXT,
  DEFAULT_HARNESS,
  DEFAULT_LEAGUE_RULES,
  DEFAULT_ROSTER_SLOTS,
} from "./lib/defaults";
import {
  MAX_TEAMS,
  MIN_TEAMS,
  SEASON_WEEKS,
  currentSeason,
  defaultTeamAbbreviation,
  defaultTeamName,
  slugify,
  weekBoundaries,
} from "./lib/season";
import { leagueDoc, membershipDoc, rulesDoc } from "./lib/validators";
import { draftType, leagueRole, scoringPreset } from "./schema";
import {
  DEFAULT_FALLBACK_MODEL_ID,
  DEFAULT_MODEL_ALLOWLIST,
  DEFAULT_MODEL_ID,
} from "@/lib/models";

type Ctx = QueryCtx | MutationCtx;

/** A league is capped at 14 teams, so every per-league team read is bounded. */
async function teamsOf(ctx: Ctx, leagueId: Id<"leagues">): Promise<Doc<"teams">[]> {
  // Bounded by construction: MIN_TEAMS..MAX_TEAMS rows per league.
  const teams = await ctx.db
    .query("teams")
    .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
    .collect();
  return teams.sort((a, b) => a.waiverPriority - b.waiverPriority);
}

export type LeagueView = {
  league: Doc<"leagues">;
  rules: Doc<"league_rules"> | null;
  teams: Doc<"teams">[];
  membership: Doc<"league_members"> | null;
  role: Doc<"league_members">["role"] | null;
  isCommissioner: boolean;
  viewerTeamId: Id<"teams"> | null;
};

/**
 * League header data: the row, its rules, its teams in waiver order and the
 * viewer's standing. Public leagues are readable without a session (spectators).
 * Shape extends the old `league.get` (`{ league, teams, membership }`).
 */
export const get = query({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, { leagueId }): Promise<LeagueView> => {
    const access = await requireLeagueRead(ctx, leagueId);
    const teams = await teamsOf(ctx, leagueId);
    const rules = await rulesOf(ctx, leagueId);
    const viewerUserId = access.viewer?.userId ?? null;
    return {
      league: access.league,
      rules,
      teams,
      membership: access.membership,
      role: access.membership?.role ?? null,
      isCommissioner: access.isCommissioner,
      viewerTeamId: teams.find((t) => viewerUserId && t.ownerUserId === viewerUserId)?._id ?? null,
    };
  },
});

async function rulesOf(ctx: Ctx, leagueId: Id<"leagues">): Promise<Doc<"league_rules"> | null> {
  return ctx.db
    .query("league_rules")
    .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
    .unique();
}

const leagueSummary = v.object({
  ...leagueDoc.fields,
  role: leagueRole,
  teamCountActual: v.number(),
});

/** Every league the signed-in user belongs to, newest first. */
export const listMine = query({
  args: {},
  returns: v.array(leagueSummary),
  handler: async (ctx) => {
    const viewer = await requireUser(ctx);
    const memberships = await ctx.db
      .query("league_members")
      .withIndex("by_userId", (q) => q.eq("userId", viewer.userId))
      .take(50);

    const rows: Array<Doc<"leagues"> & { role: Doc<"league_members">["role"]; teamCountActual: number }> =
      [];
    for (const membership of memberships) {
      const league = await ctx.db.get("leagues", membership.leagueId);
      if (!league) continue;
      rows.push({ ...league, role: membership.role, teamCountActual: league.teamCount });
    }
    return rows.sort(
      (a, b) => (b.createdAt ?? b._creationTime) - (a.createdAt ?? a._creationTime),
    );
  },
});

/** Slug lookup for `/leagues/[slug]`-style routes. Same read rule as `get`. */
export const bySlug = query({
  args: { slug: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      league: leagueDoc,
      rules: v.union(rulesDoc, v.null()),
      membership: v.union(membershipDoc, v.null()),
    }),
  ),
  handler: async (ctx, { slug }) => {
    const league = await ctx.db
      .query("leagues")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!league) return null;
    const access: LeagueAccess = await requireLeagueRead(ctx, league._id);
    return {
      league: access.league,
      rules: await rulesOf(ctx, league._id),
      membership: access.membership,
    };
  },
});

/**
 * The join page (`/leagues/join/[code]`): enough to show what is being joined
 * without exposing a private league's roster. Anyone holding the code may read it.
 */
export const byJoinCode = query({
  args: { code: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      leagueId: v.id("leagues"),
      name: v.string(),
      slug: v.string(),
      season: v.number(),
      status: leagueDoc.fields.status,
      draftType: draftType,
      isPublic: v.boolean(),
      teamCount: v.number(),
      openTeamCount: v.number(),
      alreadyMember: v.boolean(),
    }),
  ),
  handler: async (ctx, { code }) => {
    const league = await ctx.db
      .query("leagues")
      .withIndex("by_joinCode", (q) => q.eq("joinCode", code.trim().toUpperCase()))
      .unique();
    if (!league) return null;

    const teams = await teamsOf(ctx, league._id);
    const viewer = await optionalUser(ctx);
    const membership = viewer
      ? await ctx.db
          .query("league_members")
          .withIndex("by_leagueId_userId", (q) =>
            q.eq("leagueId", league._id).eq("userId", viewer.userId),
          )
          .unique()
      : null;

    return {
      leagueId: league._id,
      name: league.name,
      slug: league.slug,
      season: league.season,
      status: league.status,
      draftType: league.draftType,
      isPublic: league.isPublic,
      teamCount: teams.length,
      openTeamCount: teams.filter((t) => t.ownerUserId === undefined).length,
      alreadyMember: membership !== null,
    };
  },
});

// ------------------------------------------------------------------- creation

/** First free slug: `foo`, then `foo-2`, `foo-3`, … Bounded at 32 probes. */
async function uniqueSlug(ctx: MutationCtx, base: string): Promise<string> {
  const candidate = slugify(base);
  for (let n = 1; n <= 32; n++) {
    const slug = n === 1 ? candidate : `${candidate}-${n}`;
    const clash = await ctx.db
      .query("leagues")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!clash) return slug;
  }
  return `${candidate}-${Date.now()}`;
}

/**
 * Invite codes are 8 characters from an alphabet with no look-alikes, so a code
 * read aloud or typed from a screenshot survives. Shared with
 * `commissioner.rotateJoinCode`.
 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function randomJoinCode(length = 8): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

/**
 * Mint a code for a league that has none, retrying on the (vanishingly
 * unlikely) collision.
 */
export async function mintJoinCode(ctx: MutationCtx): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = randomJoinCode();
    const clash = await ctx.db
      .query("leagues")
      .withIndex("by_joinCode", (q) => q.eq("joinCode", code))
      .unique();
    if (!clash) return code;
  }
  throw appError("BAD_REQUEST", "Could not mint an invite code; try again.");
}

/** Everything `createLeague`/`create` accept. Optionals fall back to PRD defaults. */
const createLeagueArgs = {
    name: v.string(),
    commissionerUserId: v.id("users"),
    teamCount: v.optional(v.number()),
    season: v.optional(v.number()),
    scoringPreset: v.optional(scoringPreset),
    draftType: v.optional(draftType),
    isPublic: v.optional(v.boolean()),
    superflex: v.optional(v.boolean()),
    tePremium: v.optional(v.boolean()),
    rosterSlots: v.optional(v.record(v.string(), v.number())),
    faabBudget: v.optional(v.number()),
    playoffTeams: v.optional(v.number()),
    playoffStartWeek: v.optional(v.number()),
    regularSeasonWeeks: v.optional(v.number()),
    modelAllowlist: v.optional(v.array(v.string())),
    draftScheduledAt: v.optional(v.number()),
} as const;

type BuildLeagueArgs = {
  name: string;
  commissionerUserId: Id<"users">;
  teamCount?: number;
  season?: number;
  scoringPreset?: Doc<"league_rules">["scoringPreset"];
  draftType?: Doc<"leagues">["draftType"];
  isPublic?: boolean;
  superflex?: boolean;
  tePremium?: boolean;
  rosterSlots?: Record<string, number>;
  faabBudget?: number;
  playoffTeams?: number;
  playoffStartWeek?: number;
  regularSeasonWeeks?: number;
  modelAllowlist?: string[];
  draftScheduledAt?: number;
  /** Public `leagues.create` mints an invite code; the seed path does not. */
  joinCode?: string;
};

/**
 * Build a league skeleton: league, rules, commissioner membership, 17 weeks,
 * N unowned teams and one default agent config per team. Port of
 * the league defaults in `convex/lib/defaults.ts`.
 */
async function buildLeague(
  ctx: MutationCtx,
  args: BuildLeagueArgs,
): Promise<{ leagueId: Id<"leagues">; rulesId: Id<"league_rules">; teamIds: Id<"teams">[]; slug: string }> {
    const teamCount = args.teamCount ?? 12;
    if (teamCount < MIN_TEAMS || teamCount > MAX_TEAMS) {
      throw appError("BAD_REQUEST", `teamCount must be between ${MIN_TEAMS} and ${MAX_TEAMS}`);
    }
    const name = args.name.trim();
    if (!name) throw appError("BAD_REQUEST", "League name is required");

    const now = Date.now();
    const season = args.season ?? currentSeason(now);
    const faabBudget = args.faabBudget ?? DEFAULT_LEAGUE_RULES.faabBudget;
    const regularSeasonWeeks = args.regularSeasonWeeks ?? DEFAULT_LEAGUE_RULES.regularSeasonWeeks;
    const playoffStartWeek = args.playoffStartWeek ?? regularSeasonWeeks + 1;
    const modelAllowlist = args.modelAllowlist ?? DEFAULT_MODEL_ALLOWLIST;

    const slug = await uniqueSlug(ctx, name);
    const leagueId = await ctx.db.insert("leagues", {
      name,
      slug,
      commissionerUserId: args.commissionerUserId,
      season,
      teamCount,
      isPublic: args.isPublic ?? true,
      status: "setup",
      draftType: args.draftType ?? "snake",
      draftScheduledAt: args.draftScheduledAt,
      joinCode: args.joinCode,
      createdAt: now,
      updatedAt: now,
    });

    const rulesId = await ctx.db.insert("league_rules", {
      ...DEFAULT_LEAGUE_RULES,
      leagueId,
      scoringPreset: args.scoringPreset ?? DEFAULT_LEAGUE_RULES.scoringPreset,
      superflex: args.superflex ?? false,
      tePremium: args.tePremium ?? false,
      rosterSlots: args.rosterSlots ?? DEFAULT_ROSTER_SLOTS,
      faabBudget,
      playoffTeams: args.playoffTeams ?? DEFAULT_LEAGUE_RULES.playoffTeams,
      playoffStartWeek,
      regularSeasonWeeks,
      seasonWeeks: SEASON_WEEKS,
      modelAllowlist,
      fallbackModelId: DEFAULT_FALLBACK_MODEL_ID,
    });

    await ctx.db.insert("league_members", {
      leagueId,
      userId: args.commissionerUserId,
      role: "commissioner",
      createdAt: now,
    });

    for (let i = 0; i < SEASON_WEEKS; i++) {
      const weekNo = i + 1;
      const { startsAt, endsAt } = weekBoundaries(season, weekNo);
      await ctx.db.insert("weeks", {
        leagueId,
        weekNo,
        startsAt,
        endsAt,
        isPlayoff: weekNo >= playoffStartWeek,
        status: "upcoming",
      });
    }

    const teamIds: Id<"teams">[] = [];
    for (let i = 0; i < teamCount; i++) {
      const teamId = await ctx.db.insert("teams", {
        leagueId,
        name: defaultTeamName(i),
        abbreviation: defaultTeamAbbreviation(i),
        faabRemaining: faabBudget,
        waiverPriority: i + 1,
        karma: 0,
        draftBudgetRemaining: DEFAULT_LEAGUE_RULES.draftBudget,
        createdAt: now,
      });
      teamIds.push(teamId);
      await createAgentConfig(ctx, teamId, leagueId, modelAllowlist[0] ?? DEFAULT_MODEL_ID);
    }

  return { leagueId, rulesId, teamIds, slug };
}

/**
 * Internal builder, kept for the seed and for tests that need a league skeleton
 * without a signed-in commissioner. `leagues.create` is the public front door.
 */
export const createLeague = internalMutation({
  args: createLeagueArgs,
  returns: v.object({
    leagueId: v.id("leagues"),
    rulesId: v.id("league_rules"),
    teamIds: v.array(v.id("teams")),
  }),
  handler: async (ctx, args) => {
    const { leagueId, rulesId, teamIds } = await buildLeague(ctx, args);
    return { leagueId, rulesId, teamIds };
  },
});

/**
 * `league.create` (tRPC `protectedProcedure`): the signed-in caller becomes the
 * commissioner of a brand-new league skeleton and gets its invite code minted up
 * front, so the settings console can hand out a link immediately.
 *
 * Returns id + slug: that is all the client has ever used.
 */
export const create = mutation({
  args: {
    name: v.string(),
    teamCount: v.optional(v.number()),
    scoringPreset: v.optional(scoringPreset),
    draftType: v.optional(draftType),
    isPublic: v.optional(v.boolean()),
    superflex: v.optional(v.boolean()),
    tePremium: v.optional(v.boolean()),
    faabBudget: v.optional(v.number()),
  },
  returns: v.object({ leagueId: v.id("leagues"), slug: v.string() }),
  handler: async (ctx, args) => {
    const viewer = await requireUser(ctx);

    const name = args.name.trim();
    if (name.length < 3 || name.length > 60) {
      throw appError("BAD_REQUEST", "League names are 3-60 characters.");
    }
    const faabBudget = args.faabBudget ?? DEFAULT_LEAGUE_RULES.faabBudget;
    if (!Number.isInteger(faabBudget) || faabBudget < 0 || faabBudget > 1_000) {
      throw appError("BAD_REQUEST", "FAAB budget must be a whole number between 0 and 1,000.");
    }

    const { leagueId, slug } = await buildLeague(ctx, {
      name,
      commissionerUserId: viewer.userId,
      teamCount: args.teamCount ?? 12,
      scoringPreset: args.scoringPreset ?? "ppr",
      draftType: args.draftType ?? "snake",
      isPublic: args.isPublic ?? true,
      superflex: args.superflex ?? false,
      tePremium: args.tePremium ?? false,
      faabBudget,
      joinCode: await mintJoinCode(ctx),
    });
    return { leagueId, slug };
  },
});

/**
 * A team's agent config plus its immutable version 1. The starting model is the
 * first entry of the league's allowlist, so a narrowed allowlist still yields a
 * legal config. Idempotent per team.
 */
async function createAgentConfig(
  ctx: MutationCtx,
  teamId: Id<"teams">,
  leagueId: Id<"leagues">,
  modelId: string,
): Promise<{ configId: Id<"agent_configs">; versionId: Id<"config_versions"> }> {
  const now = Date.now();
  const existing = await ctx.db
    .query("agent_configs")
    .withIndex("by_teamId", (q) => q.eq("teamId", teamId))
    .unique();

  const configId =
    existing?._id ??
    (await ctx.db.insert("agent_configs", { teamId, leagueId, createdAt: now, updatedAt: now }));

  const v1 = await ctx.db
    .query("config_versions")
    .withIndex("by_configId_versionNo", (q) => q.eq("configId", configId).eq("versionNo", 1))
    .unique();
  if (v1) return { configId, versionId: v1._id };

  const versionId = await ctx.db.insert("config_versions", {
    configId,
    teamId,
    leagueId,
    versionNo: 1,
    contextMd: DEFAULT_AGENT_CONTEXT,
    modelId: modelId || DEFAULT_MODEL_ID,
    harness: DEFAULT_HARNESS,
    skillIds: [],
    appliedAt: now,
    changeSummary: "Initial configuration",
    createdAt: now,
  });
  await ctx.db.patch("agent_configs", configId, { currentVersionId: versionId, updatedAt: now });
  return { configId, versionId };
}

export const createDefaultAgentConfig = internalMutation({
  args: { teamId: v.id("teams"), modelId: v.optional(v.string()) },
  returns: v.object({ configId: v.id("agent_configs"), versionId: v.id("config_versions") }),
  handler: async (ctx, { teamId, modelId }) => {
    const team = await ctx.db.get("teams", teamId);
    if (!team) throw appError("NOT_FOUND", "Team not found.");
    const rules = await rulesOf(ctx, team.leagueId);
    const fallback = rules?.modelAllowlist[0] ?? DEFAULT_MODEL_ID;
    return createAgentConfig(ctx, teamId, team.leagueId, modelId ?? fallback);
  },
});

// ---------------------------------------------------------------------- join

const joinResult = v.object({
  leagueId: v.id("leagues"),
  membershipId: v.id("league_members"),
  teamId: v.union(v.id("teams"), v.null()),
});

/**
 * Join a league as an owner and claim the lowest-priority unowned team.
 * Idempotent: joining twice returns the existing membership and team.
 */
async function joinLeague(
  ctx: MutationCtx,
  leagueId: Id<"leagues">,
  userId: Id<"users">,
): Promise<{ leagueId: Id<"leagues">; membershipId: Id<"league_members">; teamId: Id<"teams"> | null }> {
  const teams = await teamsOf(ctx, leagueId);
  const existing = await ctx.db
    .query("league_members")
    .withIndex("by_leagueId_userId", (q) => q.eq("leagueId", leagueId).eq("userId", userId))
    .unique();

  if (existing) {
    const owned = teams.find((t) => t.ownerUserId === userId) ?? null;
    return { leagueId, membershipId: existing._id, teamId: owned?._id ?? null };
  }

  const membershipId = await ctx.db.insert("league_members", {
    leagueId,
    userId,
    role: "owner",
    createdAt: Date.now(),
  });

  const openTeam = teams.find((t) => t.ownerUserId === undefined) ?? null;
  if (!openTeam) return { leagueId, membershipId, teamId: null };

  // Mutations are transactions, so the Postgres "re-check owner_user_id is null
  // in the UPDATE" race guard is unnecessary here.
  await ctx.db.patch("teams", openTeam._id, { ownerUserId: userId });
  return { leagueId, membershipId, teamId: openTeam._id };
}

/** Join a public league and claim the first unowned team. */
export const join = mutation({
  args: { leagueId: v.id("leagues") },
  returns: joinResult,
  handler: async (ctx, { leagueId }) => {
    const viewer = await requireUser(ctx);
    const league = await ctx.db.get("leagues", leagueId);
    if (!league) throw appError("NOT_FOUND", "League not found.");
    if (!league.isPublic) throw appError("FORBIDDEN", "This league is invite-only.");
    return joinLeague(ctx, leagueId, viewer.userId);
  },
});

/** Redeem an invite code. Works for private leagues — the code is the grant. */
export const joinByCode = mutation({
  args: { code: v.string() },
  returns: joinResult,
  handler: async (ctx, { code }) => {
    const viewer = await requireUser(ctx);
    const league = await ctx.db
      .query("leagues")
      .withIndex("by_joinCode", (q) => q.eq("joinCode", code.trim().toUpperCase()))
      .unique();
    if (!league) throw appError("BAD_REQUEST", "That invite code is not valid.");
    return joinLeague(ctx, league._id, viewer.userId);
  },
});
