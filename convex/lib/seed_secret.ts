/**
 * Shared guard for the seed-only public functions (`seed.importBatch`,
 * `seed.lookupLegacy`, `seed.runBase`, `users.byEmailPublic`).
 *
 * These have to be public because `scripts/seed-convex.ts` calls them over HTTP
 * with `ConvexHttpClient`, which cannot reach `internal.*`. `SEED_SECRET` is a
 * deployment env var that exists only on dev deployments, so on a deployment
 * without it every one of these functions is dead.
 */
import { appError } from "./errors";

export function requireSeedSecret(secret: string): void {
  const expected = process.env.SEED_SECRET;
  if (!expected) {
    throw appError("FORBIDDEN", "Seeding is disabled: SEED_SECRET is not set on this deployment.");
  }
  if (secret !== expected) {
    throw appError("FORBIDDEN", "Bad seed secret.");
  }
}
