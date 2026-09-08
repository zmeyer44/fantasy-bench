/**
 * Authorization helpers — the access ladder every function goes through
 * (any viewer → signed in → league read → league member → commissioner).
 *
 * - Spectators are read-only; public leagues are readable without a session.
 * - Owners may edit only their own team's config; commissioners administer only
 *   their own league.
 */
import { getAuthUserId } from "@convex-dev/auth/server";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { appError } from "./errors";

type Ctx = QueryCtx | MutationCtx;

export type Viewer = { userId: Id<"users">; user: Doc<"users"> };

export async function optionalUser(ctx: Ctx): Promise<Viewer | null> {
  const subject = await getAuthUserId(ctx);
  if (!subject) return null;
  // Convex Auth's `subject` is `"<userId>|<sessionId>"`; a token from another
  // issuer (or a hand-built test identity) yields a string that is not an id at
  // all, and `ctx.db.get` throws on those. Treat that as "signed out".
  const userId = ctx.db.normalizeId("users", subject);
  if (!userId) return null;
  const user = await ctx.db.get("users", userId);
  if (!user) return null;
  return { userId, user };
}

export async function requireUser(ctx: Ctx): Promise<Viewer> {
  const viewer = await optionalUser(ctx);
  if (!viewer) throw appError("UNAUTHORIZED", "Sign in to continue.");
  return viewer;
}

export async function getMembership(
  ctx: Ctx,
  leagueId: Id<"leagues">,
  userId: Id<"users">,
): Promise<Doc<"league_members"> | null> {
  return ctx.db
    .query("league_members")
    .withIndex("by_leagueId_userId", (q) => q.eq("leagueId", leagueId).eq("userId", userId))
    .unique();
}

export type LeagueAccess = {
  league: Doc<"leagues">;
  viewer: Viewer | null;
  membership: Doc<"league_members"> | null;
  isCommissioner: boolean;
};

/** leagueReadProcedure: members always; anyone (even signed out) if the league is public. */
export async function requireLeagueRead(ctx: Ctx, leagueId: Id<"leagues">): Promise<LeagueAccess> {
  const league = await ctx.db.get("leagues", leagueId);
  if (!league) throw appError("NOT_FOUND", "League not found.");
  const viewer = await optionalUser(ctx);
  const membership = viewer ? await getMembership(ctx, leagueId, viewer.userId) : null;
  if (!league.isPublic && !membership) {
    throw appError(viewer ? "FORBIDDEN" : "UNAUTHORIZED", "This league is private.");
  }
  return { league, viewer, membership, isCommissioner: membership?.role === "commissioner" };
}

/** leagueMemberProcedure: a signed-in member of any role. */
export async function requireMember(
  ctx: Ctx,
  leagueId: Id<"leagues">,
): Promise<LeagueAccess & { viewer: Viewer; membership: Doc<"league_members"> }> {
  const viewer = await requireUser(ctx);
  const league = await ctx.db.get("leagues", leagueId);
  if (!league) throw appError("NOT_FOUND", "League not found.");
  const membership = await getMembership(ctx, leagueId, viewer.userId);
  if (!membership) throw appError("FORBIDDEN", "You are not a member of this league.");
  return { league, viewer, membership, isCommissioner: membership.role === "commissioner" };
}

/** commissionerProcedure. */
export async function requireCommissioner(ctx: Ctx, leagueId: Id<"leagues">) {
  const access = await requireMember(ctx, leagueId);
  if (!access.isCommissioner) throw appError("FORBIDDEN", "Commissioner only.");
  return access;
}

/** Team owner or the league's commissioner (config edits, note-to-agent, veto votes on behalf). */
export async function requireOwnerOrCommissioner(ctx: Ctx, teamId: Id<"teams">) {
  const team = await ctx.db.get("teams", teamId);
  if (!team) throw appError("NOT_FOUND", "Team not found.");
  const access = await requireMember(ctx, team.leagueId);
  if (team.ownerUserId !== access.viewer.userId && !access.isCommissioner) {
    throw appError("FORBIDDEN", "Only the team owner or the commissioner may do that.");
  }
  return { ...access, team };
}

/** Team ids the viewer owns in a league (transparency-mode checks for DMs). */
export async function viewerTeamIds(
  ctx: Ctx,
  leagueId: Id<"leagues">,
  viewer: Viewer | null,
): Promise<Id<"teams">[]> {
  if (!viewer) return [];
  // Bounded: a league has at most 14 teams.
  const teams = await ctx.db
    .query("teams")
    .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
    .collect();
  return teams.filter((t) => t.ownerUserId === viewer.userId).map((t) => t._id);
}
