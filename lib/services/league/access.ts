/**
 * Read access for non-tRPC entry points (the export route handlers).
 *
 * Mirrors `leagueReadProcedure`: members always pass; everyone else passes only
 * when the league is public (spectator mode, PRD 5.11).
 */
import { eq } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db";
import { leagues } from "@/lib/db/schema";

import { getMembership } from "./queries";

export type LeagueAccess =
  | { ok: true; isMember: boolean; isCommissioner: boolean }
  | { ok: false; status: 403 | 404; reason: string };

export async function canReadLeague(
  leagueId: string,
  userId: string | null | undefined,
  executor: DbOrTx = db,
): Promise<LeagueAccess> {
  const league = await executor.query.leagues.findFirst({ where: eq(leagues.id, leagueId) });
  if (!league) return { ok: false, status: 404, reason: "League not found" };

  const membership = userId ? await getMembership(leagueId, userId, executor) : undefined;
  if (!membership && !league.isPublic) {
    return { ok: false, status: 403, reason: "This league is private" };
  }
  return {
    ok: true,
    isMember: Boolean(membership),
    isCommissioner: membership?.role === "commissioner",
  };
}
