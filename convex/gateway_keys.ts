/**
 * Bring-your-own keys (one per team): Vercel AI Gateway, OpenRouter, Anthropic or OpenAI.
 *
 * The commissioner's spend caps protect the league's shared key. An owner who
 * wants to spend more can register their own key: their agent's runs are then
 * billed to that key and bypass every cap, while the ledger keeps metering
 * them exactly like everyone else's (cost dashboards, benchmarks and the
 * league's USD total all still include them).
 *
 * Secrets never leave the server: `set` verifies the key against its vendor,
 * encrypts it (`convex/lib/secrets.ts`) and stores ciphertext; every read model
 * returns the last four characters at most. The plaintext is decrypted only in
 * the run action. `lib/key-providers.ts` lists the vendors; `lib/models.ts`
 * says which catalog models OpenRouter serves.
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
import {
  DEFAULT_KEY_PROVIDER,
  KEY_PROVIDER_INFO,
  keyProviderFromPrefix,
  keyProviderOf,
  type KeyProvider,
} from "../lib/key-providers";
import { requireLeagueRead, requireOwnerOrCommissioner } from "./lib/auth";
import { appError } from "./lib/errors";
import { keyProviderValidator } from "./schema";
import { encryptSecret, keyTail, secretsConfigured } from "./lib/secrets";

const MIN_KEY_CHARS = 16;
const MAX_KEY_CHARS = 512;

const OPENROUTER_KEY_ENDPOINT = "https://openrouter.ai/api/v1/key";



export type GatewayKeyStatus = {
  /** True when the team runs on its owner's own key. Visible to the whole league. */
  hasKey: boolean;
  /** Which vendor issued the key. Visible to the whole league: it decides which models the team can run. */
  provider: KeyProvider | null;
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
      provider: row ? keyProviderOf(row) : null,
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
    provider: keyProviderValidator,
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
        provider: args.provider,
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
      provider: args.provider,
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
 * Check an OpenRouter key: `GET /api/v1/key` describes the key (label, limit,
 * usage) and costs nothing. A bad key answers 401. The model list is public
 * there too, so it is no probe either.
 */
export function verifyOpenRouterKey(apiKey: string): Promise<KeyVerification> {
  return verifyAuthenticatedEndpoint(OPENROUTER_KEY_ENDPOINT, { Authorization: `Bearer ${apiKey}` });
}

type KeyVerification = { ok: true } | { ok: false; error: string };

/** Authenticated account/model reads validate credentials without generating billable tokens. */
async function verifyAuthenticatedEndpoint(url: string, headers: Record<string, string>): Promise<KeyVerification> {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (response.ok) return { ok: true };
    // Never echo a provider response: OpenAI error messages can include the supplied key.
    const detail = response.status === 401
      ? "Invalid or expired API key."
      : response.status === 403
        ? "This key does not have permission to verify access. Check its API permissions."
        : response.status === 429
          ? "Verification is rate limited. Try again shortly."
          : "Verification is unavailable. Check your account and try again.";
    return { ok: false, error: `${detail} (HTTP ${response.status})` };
  } catch {
    return { ok: false, error: "Could not reach the provider to verify the key. Try again shortly." };
  }
}

export function verifyKey(provider: KeyProvider, apiKey: string): Promise<KeyVerification> {
  switch (provider) {
    case "openrouter": return verifyOpenRouterKey(apiKey);
    case "anthropic": return verifyAuthenticatedEndpoint("https://api.anthropic.com/v1/models?limit=1", {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    });
    case "openai": return verifyAuthenticatedEndpoint("https://api.openai.com/v1/models", {
      Authorization: `Bearer ${apiKey}`,
    });
    case "vercel": return verifyGatewayKey(apiKey);
  }
}

/**
 * Register the team's own key. Verifies it with its vendor, encrypts it,
 * stores it. The plaintext is never persisted and never returned. Replacing a
 * key may switch vendors; the team's saved model may then be one the new
 * vendor does not serve, which the editor flags and the next run reports.
 */
export const set = action({
  args: {
    teamId: v.id("teams"),
    apiKey: v.string(),
    /** Defaults to Vercel for callers that predate OpenRouter support. */
    provider: v.optional(keyProviderValidator),
    skipVerification: v.optional(v.boolean()),
  },
  returns: v.object({ last4: v.string(), verified: v.boolean(), provider: keyProviderValidator }),
  handler: async (ctx, { teamId, apiKey, provider: requestedProvider, skipVerification }) => {
    const provider: KeyProvider = requestedProvider ?? DEFAULT_KEY_PROVIDER;
    const access: { leagueId: Id<"leagues">; userId: Id<"users"> } | null = await ctx.runQuery(
      internal.gateway_keys.canManageTeam,
      { teamId },
    );
    if (!access) throw appError("FORBIDDEN", "Only the team owner or the commissioner may set a key.");
    if (!secretsConfigured()) {
      throw appError("BAD_REQUEST", "This deployment cannot store keys yet (BYOK_ENCRYPTION_KEY is not set).");
    }
    const key = apiKey.trim();
    const vendor = KEY_PROVIDER_INFO[provider];
    if (key.length < MIN_KEY_CHARS || key.length > MAX_KEY_CHARS || /\s/.test(key)) {
      throw appError("BAD_REQUEST", `That does not look like ${aOrAn(vendor.name)} key.`);
    }
    // A key pasted into the wrong vendor's slot would fail verification anyway,
    // but the vendor's error would not say why.
    const looksLike = keyProviderFromPrefix(key);
    if (looksLike !== null && looksLike !== provider) {
      throw appError(
        "BAD_REQUEST",
        `That looks like ${aOrAn(KEY_PROVIDER_INFO[looksLike].name)} key, not ${aOrAn(vendor.name)} key.`,
      );
    }
    // Tests and offline dev may skip the vendor call, but only on deployments
    // that opt in — a client cannot talk its way past verification otherwise.
    const mayskip = skipVerification === true && process.env.BYOK_ALLOW_UNVERIFIED === "1";
    const verified = mayskip ? { ok: true as const } : await verifyKey(provider, key);
    if (!verified.ok) {
      throw appError("BAD_REQUEST", `${vendor.name}: ${verified.error}`);
    }
    const sealed = await encryptSecret(key);
    await ctx.runMutation(internal.gateway_keys.store, {
      teamId,
      leagueId: access.leagueId,
      userId: access.userId,
      provider,
      ...sealed,
      last4: keyTail(key),
      verifiedAt: mayskip ? undefined : Date.now(),
    });
    return { last4: keyTail(key), verified: !mayskip, provider };
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
    v.object({
      id: v.id("team_gateway_keys"),
      provider: keyProviderValidator,
      ciphertext: v.string(),
      iv: v.string(),
      last4: v.string(),
    }),
  ),
  handler: async (ctx, { teamId }) => {
    const row = await rowFor(ctx, teamId);
    return row
      ? { id: row._id, provider: keyProviderOf(row), ciphertext: row.ciphertext, iv: row.iv, last4: row.last4 }
      : null;
  },
});

function aOrAn(noun: string): string {
  return `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;
}

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
