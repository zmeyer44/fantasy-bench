import { api } from "@/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";

import { fetchAuthQuery } from "./server";

export type Viewer = NonNullable<FunctionReturnType<typeof api.users.me>>;

/** The signed-in Convex Auth user for server components, or null when anonymous. */
export async function getViewer(): Promise<Viewer | null> {
  return fetchAuthQuery(api.users.me, {});
}

/** Membership of the viewer in a league, derived from `users.me`. */
export function viewerMembership(viewer: Viewer | null, leagueId: string) {
  return viewer?.memberships.find((m) => m.leagueId === leagueId) ?? null;
}
