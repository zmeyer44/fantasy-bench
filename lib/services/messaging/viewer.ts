/**
 * Who is looking at a social page.
 *
 * The negotiation viewer, thread view and forum all need the same three facts:
 * is this a member, is it the commissioner, and which teams does this person
 * own (a party to a thread sees a delayed-reveal negotiation immediately).
 *
 * Server Components only — it reads the session from request headers.
 */
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { teams } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { getMembership } from "@/lib/services/league/queries";

export type SocialViewer = {
  userId: string | null;
  isMember: boolean;
  isOwner: boolean;
  isCommissioner: boolean;
  /** Teams in this league owned by the viewer. */
  teamIds: string[];
};

export async function getSocialViewer(leagueId: string): Promise<SocialViewer> {
  const session = await getSession();
  if (!session) {
    return {
      userId: null,
      isMember: false,
      isOwner: false,
      isCommissioner: false,
      teamIds: [],
    };
  }

  const membership = await getMembership(leagueId, session.user.id);
  const owned = await db
    .select({ id: teams.id, ownerUserId: teams.ownerUserId })
    .from(teams)
    .where(eq(teams.leagueId, leagueId));

  return {
    userId: session.user.id,
    isMember: Boolean(membership),
    isOwner: membership?.role === "owner" || membership?.role === "commissioner",
    isCommissioner: membership?.role === "commissioner",
    teamIds: owned.filter((t) => t.ownerUserId === session.user.id).map((t) => t.id),
  };
}
