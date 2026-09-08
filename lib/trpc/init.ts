/**
 * tRPC root: context + the procedure ladder.
 *
 *   publicProcedure          — anyone
 *   protectedProcedure       — signed in
 *   leagueReadProcedure      — input { leagueId }; members, or anyone if public
 *   leagueMemberProcedure    — input { leagueId }; members only
 *   commissionerProcedure    — input { leagueId }; commissioner only
 *
 * `.input()` MUST come before `.use()` — tRPC 11 captures the input type at the
 * moment `.use()` is called, so a middleware chained the other way round sees
 * `input: unknown`.
 */
import { initTRPC, TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import superjson from "superjson";
import { z } from "zod";
import { ZodError } from "zod";

import { auth, type AuthSession, type AuthUser } from "@/lib/auth/server";
import { db, type Db } from "@/lib/db";
import { leagueMembers, leagues } from "@/lib/db/schema";

export type TRPCContext = {
  db: Db;
  session: AuthSession | null;
  user: AuthUser | null;
  headers: Headers;
};

/** Build a context from request headers. Used by both the fetch adapter and the RSC caller. */
export async function createTRPCContext(opts: { headers: Headers }): Promise<TRPCContext> {
  const session = await auth.api.getSession({ headers: opts.headers });
  return {
    db,
    session: session ?? null,
    user: session?.user ?? null,
    headers: opts.headers,
  };
}

const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof ZodError ? z.treeifyError(error.cause) : null,
      },
    };
  },
});

export const router = t.router;
export const middleware = t.middleware;
export const mergeRouters = t.mergeRouters;
export const createCallerFactory = t.createCallerFactory;

export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.session || !ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in to continue" });
  }
  return next({ ctx: { ...ctx, session: ctx.session, user: ctx.user } });
});

export const leagueIdInput = z.object({ leagueId: z.uuid() });

/**
 * Read access to a league. Members always pass; non-members pass only when the
 * league is public (spectator mode), and get `membership: null`.
 */
export const leagueReadProcedure = t.procedure
  .input(leagueIdInput)
  .use(async ({ ctx, input, next }) => {
    const league = await ctx.db.query.leagues.findFirst({
      where: eq(leagues.id, input.leagueId),
    });
    if (!league) throw new TRPCError({ code: "NOT_FOUND", message: "League not found" });

    const membership = ctx.user
      ? ((await ctx.db.query.leagueMembers.findFirst({
          where: and(
            eq(leagueMembers.leagueId, input.leagueId),
            eq(leagueMembers.userId, ctx.user.id),
          ),
        })) ?? null)
      : null;

    if (!membership && !league.isPublic) {
      throw new TRPCError({ code: "FORBIDDEN", message: "This league is private" });
    }

    return next({ ctx: { ...ctx, league, membership } });
  });

/** Write access to a league: membership required. */
export const leagueMemberProcedure = protectedProcedure
  .input(leagueIdInput)
  .use(async ({ ctx, input, next }) => {
    const league = await ctx.db.query.leagues.findFirst({
      where: eq(leagues.id, input.leagueId),
    });
    if (!league) throw new TRPCError({ code: "NOT_FOUND", message: "League not found" });

    const membership = await ctx.db.query.leagueMembers.findFirst({
      where: and(
        eq(leagueMembers.leagueId, input.leagueId),
        eq(leagueMembers.userId, ctx.user.id),
      ),
    });
    if (!membership) {
      throw new TRPCError({ code: "FORBIDDEN", message: "You are not in this league" });
    }

    return next({ ctx: { ...ctx, league, membership } });
  });

/**
 * `leagueProcedure` is an alias for the member-scoped variant — the common case
 * for mutations. Read-only procedures should use `leagueReadProcedure`.
 */
export const leagueProcedure = leagueMemberProcedure;

export const commissionerProcedure = leagueMemberProcedure.use(async ({ ctx, next }) => {
  if (ctx.membership.role !== "commissioner") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Commissioner only" });
  }
  return next({ ctx });
});
