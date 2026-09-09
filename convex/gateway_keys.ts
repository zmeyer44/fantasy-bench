/**
 * Bring-your-own Vercel AI Gateway keys (one per team).
 *
 * The commissioner's spend caps protect the league's shared key. An owner who
 * wants to spend more can register their own gateway key: their agent's runs
 * are then billed to that key and bypass every cap, while the ledger keeps
 * metering them exactly like everyone else's (cost dashboards, benchmarks and
 * the league's USD total all still include them).
 *
 * Secrets never leave the server: `set` verifies the key against the gateway,
 * encrypts it (`convex/lib/secrets.ts`) and stores ciphertext; every read model
 * returns the last four characters at most. The plaintext is decrypted only in
 * the run action.
 */
import { createGateway } from "@ai-sdk/gateway";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { requireLeagueRead, requireOwnerOrCommissioner } from "./lib/auth";
import { appError } from "./lib/errors";
import { encryptSecret, keyTail, secretsConfigured } from "./lib/secrets";

const MIN_KEY_CHARS = 16;
const MAX_KEY_CHARS = 512;

export type GatewayKeyStatus = {
  /** True when the team runs on its owner's own key. Visible to the whole league. */
  hasKey: boolean;
  /** The rest is for the owner and commissioner only. */
  canManage: boolean;
  last4: string | null;
  addedAt: number | null;
  verifiedAt: number | null;
  lastUsedAt: number | null;
  lastError: string | null;
  /** False when the deployment has no encryption key configured (nothing can be stored). */
  configured: boolean;
};

async function rowFor(ctx: QueryCtx | MutationCtx, teamId: Id<"teams">): Promise<Doc<"team_gateway_keys"> | null> {
  return ctx.db
    .query("team_gateway_keys")
    .withIndex("by_teamId", (q) => q.eq("teamId", teamId))
    .unique();
}

/** Whether the team has a key, and its envelope for those allowed to manage it. */
export const status = query({
  args: { leagueId: v.id("leagues"), teamId: v.id("teams") },
  handler: async (ctx, { leagueId, teamId }): Promise<GatewayKeyStatus> => {
    const access = await requireLeagueRead(ctx, leagueId);
    const team = await ctx.db.get("teams", teamId);
    if (!team || team.leagueId !== leagueId) throw appError("NOT_FOUND", "Team not found in this league.");
    const viewerUserId = access.viewer?.userId ?? null;
    const canManage =
      viewerUserId !== null && (team.ownerUserId === viewerUserId || access.isCommissioner);
    const row = await rowFor(ctx, teamId);
    const hidden = { last4: null, addedAt: null, verifiedAt: null, lastUsedAt: null, lastError: null };
    return {
      hasKey: row !== null,
      canManage,
      configured: secretsConfigured(),
      ...(row && canManage
        ? {
            last4: row.last4,
            addedAt: row.createdAt,
            verifiedAt: row.verifiedAt ?? null,
            lastUsedAt: row.lastUsedAt ?? null,
            lastError: row.lastError ?? null,
          }
        : hidden),
    };
  },
});

/** The write right, checked from the `set` action (actions have no `db`). */
export const canManageTeam = internalQuery({
  args: { teamId: v.id("teams") },
  returns: v.union(v.null(), v.object({ leagueId: v.id("leagues"), userId: v.id("users") })),
  handler: async (ctx, { teamId }) => {
    try {
      const access = await requireOwnerOrCommissioner(ctx, teamId);
      return { leagueId: access.team.leagueId, userId: access.viewer.userId };
    } catch {
      return null;
    }
  },
});

/** Store (or replace) the encrypted key. Internal: `set` is the only caller. */
export const store = internalMutation({
  args: {
    teamId: v.id("teams"),
    leagueId: v.id("leagues"),
    userId: v.id("users"),
    ciphertext: v.string(),
    iv: v.string(),
    last4: v.string(),
    verifiedAt: v.optional(v.number()),
  },
  returns: v.id("team_gateway_keys"),
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await rowFor(ctx, args.teamId);
    if (existing) {
      await ctx.db.patch("team_gateway_keys", existing._id, {
        ciphertext: args.ciphertext,
        iv: args.iv,
        last4: args.last4,
        addedByUserId: args.userId,
        createdAt: now,
        verifiedAt: args.verifiedAt,
        lastUsedAt: undefined,
        lastError: undefined,
      });
      return existing._id;
    }
    return ctx.db.insert("team_gateway_keys", {
      leagueId: args.leagueId,
      teamId: args.teamId,
      ciphertext: args.ciphertext,
      iv: args.iv,
      last4: args.last4,
      addedByUserId: args.userId,
      createdAt: now,
      verifiedAt: args.verifiedAt,
    });
  },
});

/**
 * Check a key against the gateway before storing it: one account call, no
 * model spend. The credits endpoint is the right probe — the model list is
 * public and answers any key. A network failure is reported, not swallowed —
 * the owner should know whether the key works before their next window.
 */
export async function verifyGatewayKey(apiKey: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const gateway = createGateway({ apiKey });
    await gateway.getCredits();
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message.slice(0, 300) };
  }
}

/**
 * Register the team's own gateway key. Verifies it, encrypts it, stores it.
 * The plaintext is never persisted and never returned.
 */
export const set = action({
  args: { teamId: v.id("teams"), apiKey: v.string(), skipVerification: v.optional(v.boolean()) },
  returns: v.object({ last4: v.string(), verified: v.boolean() }),
  handler: async (ctx, { teamId, apiKey, skipVerification }) => {
    const access: { leagueId: Id<"leagues">; userId: Id<"users"> } | null = await ctx.runQuery(
      internal.gateway_keys.canManageTeam,
      { teamId },
    );
    if (!access) throw appError("FORBIDDEN", "Only the team owner or the commissioner may set a key.");
    if (!secretsConfigured()) {
      throw appError("BAD_REQUEST", "This deployment cannot store keys yet (BYOK_ENCRYPTION_KEY is not set).");
    }
    const key = apiKey.trim();
    if (key.length < MIN_KEY_CHARS || key.length > MAX_KEY_CHARS || /\s/.test(key)) {
      throw appError("BAD_REQUEST", "That does not look like a gateway key.");
    }
    // Tests and offline dev may skip the gateway call, but only on deployments
    // that opt in — a client cannot talk its way past verification otherwise.
    const mayskip = skipVerification === true && process.env.BYOK_ALLOW_UNVERIFIED === "1";
    const verified = mayskip ? { ok: true as const } : await verifyGatewayKey(key);
    if (!verified.ok) {
      throw appError("BAD_REQUEST", `The gateway rejected that key: ${verified.error}`);
    }
    const sealed = await encryptSecret(key);
    await ctx.runMutation(internal.gateway_keys.store, {
      teamId,
      leagueId: access.leagueId,
      userId: access.userId,
      ...sealed,
      last4: keyTail(key),
      verifiedAt: mayskip ? undefined : Date.now(),
    });
    return { last4: keyTail(key), verified: !mayskip };
  },
});

/** Remove the key. The team falls back to the league key and its caps from the next run. */
export const remove = mutation({
  args: { teamId: v.id("teams") },
  returns: v.null(),
  handler: async (ctx, { teamId }) => {
    await requireOwnerOrCommissioner(ctx, teamId);
    const row = await rowFor(ctx, teamId);
    if (row) await ctx.db.delete("team_gateway_keys", row._id);
    return null;
  },
});

/** The runtime's read: ciphertext for the run action to decrypt. Internal only. */
export const forTeam = internalQuery({
  args: { teamId: v.id("teams") },
  returns: v.union(
    v.null(),
    v.object({ id: v.id("team_gateway_keys"), ciphertext: v.string(), iv: v.string(), last4: v.string() }),
  ),
  handler: async (ctx, { teamId }) => {
    const row = await rowFor(ctx, teamId);
    return row ? { id: row._id, ciphertext: row.ciphertext, iv: row.iv, last4: row.last4 } : null;
  },
});

/** Stamp usage or a failure on the key row, from the run action. */
export const markUsed = internalMutation({
  args: { keyId: v.id("team_gateway_keys"), error: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { keyId, error }) => {
    const row = await ctx.db.get("team_gateway_keys", keyId);
    if (!row) return null;
    await ctx.db.patch("team_gateway_keys", keyId, {
      lastUsedAt: Date.now(),
      lastError: error ? error.slice(0, 300) : undefined,
    });
    return null;
  },
});
