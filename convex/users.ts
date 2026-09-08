/**
 * The viewer's identity and league memberships.
 *
 * `users.me` is new in the Convex port (§2.1 "Adds not present in tRPC today"):
 * every client needs one subscription that says who it is and which leagues and
 * teams it can act on, without a round trip per league.
 */
import { v } from "convex/values";

import { internalQuery, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { optionalUser } from "./lib/auth";
import { requireSeedSecret } from "./lib/seed_secret";
import { leagueRole } from "./schema";

/** A user belongs to few leagues; the page bounds an abusive account. */
const MAX_MEMBERSHIPS = 50;

const membershipSummary = v.object({
  leagueId: v.id("leagues"),
  leagueName: v.string(),
  slug: v.string(),
  role: leagueRole,
  teamId: v.union(v.id("teams"), v.null()),
});

export const me = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      userId: v.id("users"),
      email: v.union(v.string(), v.null()),
      name: v.union(v.string(), v.null()),
      memberships: v.array(membershipSummary),
    }),
  ),
  handler: async (ctx) => {
    const viewer = await optionalUser(ctx);
    if (!viewer) return null;

    const memberships = await ctx.db
      .query("league_members")
      .withIndex("by_userId", (q) => q.eq("userId", viewer.userId))
      .take(MAX_MEMBERSHIPS);

    // Bounded: at most one team per league, and the memberships page is capped above.
    const ownedTeams = await ctx.db
      .query("teams")
      .withIndex("by_ownerUserId", (q) => q.eq("ownerUserId", viewer.userId))
      .take(MAX_MEMBERSHIPS);
    const teamByLeague = new Map<string, Id<"teams">>(
      ownedTeams.map((team) => [team.leagueId, team._id]),
    );

    const out: Array<{
      leagueId: Id<"leagues">;
      leagueName: string;
      slug: string;
      role: Doc<"league_members">["role"];
      teamId: Id<"teams"> | null;
    }> = [];

    for (const membership of memberships) {
      const league = await ctx.db.get("leagues", membership.leagueId);
      if (!league) continue;
      out.push({
        leagueId: league._id,
        leagueName: league.name,
        slug: league.slug,
        role: membership.role,
        teamId: teamByLeague.get(league._id) ?? null,
      });
    }

    return {
      userId: viewer.userId,
      email: viewer.user.email ?? null,
      name: viewer.user.name ?? null,
      memberships: out,
    };
  },
});

/** `commissioner.assignOwnerByEmail` (Phase 3) and the seed script resolve users this way. */
export async function findByEmail(ctx: QueryCtx, email: string): Promise<Doc<"users"> | null> {
  return ctx.db
    .query("users")
    .withIndex("email", (q) => q.eq("email", email.trim().toLowerCase()))
    .unique();
}

export const byEmail = internalQuery({
  args: { email: v.string() },
  returns: v.union(v.null(), v.id("users")),
  handler: async (ctx, { email }) => (await findByEmail(ctx, email))?._id ?? null,
});

/**
 * Seed-only: `scripts/seed-convex.ts` signs the demo user up through the real
 * password flow and then needs its `Id<"users">` to map the golden dataset's
 * legacy user id. Guarded by `SEED_SECRET`; see convex/lib/seed_secret.ts.
 */
export const byEmailPublic = query({
  args: { secret: v.string(), email: v.string() },
  returns: v.union(v.null(), v.object({ userId: v.id("users"), name: v.union(v.string(), v.null()) })),
  handler: async (ctx, { secret, email }) => {
    requireSeedSecret(secret);
    const user = await findByEmail(ctx, email);
    return user ? { userId: user._id, name: user.name ?? null } : null;
  },
});
