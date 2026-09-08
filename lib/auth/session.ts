import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth, type AuthSession, type AuthUser } from "./server";

/**
 * Read the current session from the incoming request headers.
 * Returns `null` for anonymous visitors — spectator pages rely on this.
 */
export async function getSession(): Promise<AuthSession | null> {
  return auth.api.getSession({ headers: await headers() });
}

/** The signed-in user, or `null`. */
export async function getUser(): Promise<AuthUser | null> {
  const session = await getSession();
  return session?.user ?? null;
}

/**
 * Require a signed-in user or bounce to `/login` with a return path.
 * Never returns when unauthenticated (`redirect()` throws).
 */
export async function requireUser(redirectTo?: string): Promise<AuthUser> {
  const session = await getSession();
  if (!session) {
    const next = redirectTo ? `?next=${encodeURIComponent(redirectTo)}` : "";
    redirect(`/login${next}`);
  }
  return session.user;
}
