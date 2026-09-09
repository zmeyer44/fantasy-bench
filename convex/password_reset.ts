import { v } from "convex/values";

import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";

export const RESET_REQUEST_COOLDOWN_MS = 60_000;

export function normalizeResetEmail(email: string): string {
  return email.trim().toLowerCase();
}

export type ResetRequestDecision = "send" | "accept-without-email" | "throttled";

export function resetRequestDecision(input: {
  allowed: boolean;
  accountExists: boolean;
}): ResetRequestDecision {
  if (!input.allowed) return "throttled";
  return input.accountExists ? "send" : "accept-without-email";
}

async function findPasswordAccountEmail(
  ctx: QueryCtx | MutationCtx,
  email: string,
): Promise<string | null> {
  const submittedEmail = email.trim();
  const normalizedEmail = normalizeResetEmail(email);
  const normalizedAccount = await ctx.db
    .query("authAccounts")
    .withIndex("providerAndAccountId", (q) =>
      q.eq("provider", "password").eq("providerAccountId", normalizedEmail),
    )
    .unique();
  if (normalizedAccount) return normalizedEmail;
  if (submittedEmail === normalizedEmail) return null;

  // Accounts created before normalization used the submitted casing as their
  // provider ID. Exact-case fallback preserves those existing credentials.
  const legacyAccount = await ctx.db
    .query("authAccounts")
    .withIndex("providerAndAccountId", (q) =>
      q.eq("provider", "password").eq("providerAccountId", submittedEmail),
    )
    .unique();
  return legacyAccount ? submittedEmail : null;
}

export const resolveAccountEmail = internalQuery({
  args: { email: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: (ctx, { email }) => findPasswordAccountEmail(ctx, email),
});

/**
 * Atomically checks and records a reset request. Unknown and known addresses
 * share the same cooldown so the public response cannot reveal membership.
 */
export const begin = internalMutation({
  args: { email: v.string() },
  returns: v.object({
    allowed: v.boolean(),
    accountExists: v.boolean(),
    accountEmail: v.union(v.string(), v.null()),
    retryAfterSeconds: v.number(),
  }),
  handler: async (ctx, { email }) => {
    const normalizedEmail = normalizeResetEmail(email);
    const now = Date.now();
    const previous = await ctx.db
      .query("password_reset_attempts")
      .withIndex("by_normalizedEmail", (q) => q.eq("normalizedEmail", normalizedEmail))
      .unique();
    const elapsed = previous ? now - previous.lastRequestedAt : RESET_REQUEST_COOLDOWN_MS;
    const allowed = elapsed >= RESET_REQUEST_COOLDOWN_MS;
    const accountEmail = await findPasswordAccountEmail(ctx, email);

    if (allowed) {
      if (previous) {
        await ctx.db.patch(previous._id, { lastRequestedAt: now });
      } else {
        await ctx.db.insert("password_reset_attempts", { normalizedEmail, lastRequestedAt: now });
      }
    }

    return {
      allowed,
      accountExists: accountEmail !== null,
      accountEmail,
      retryAfterSeconds: allowed
        ? 0
        : Math.max(1, Math.ceil((RESET_REQUEST_COOLDOWN_MS - elapsed) / 1000)),
    };
  },
});
