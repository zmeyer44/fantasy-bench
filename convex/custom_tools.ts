/**
 * Team-scoped custom tools (PRD open question 5, the owner-facing half).
 *
 * A custom tool is one `custom_providers` row with `teamId` set: an HTTP/JSON
 * source the runtime turns into a read-only tool named `custom_<slug>`, present
 * in every window (`runtime/tools/custom.ts`). Unlike context, skills and tool
 * overrides these are NOT versioned — a change applies to the next run — so the
 * console says so and keeps them in their own section.
 *
 * Reads are public within the league like every other config surface, with one
 * exception: request headers usually carry API keys, so `listForTeam` returns
 * header *names* to everyone and header values only to the team's editors.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { action, internalQuery, mutation, query } from "./_generated/server";
import { requireLeagueRead, requireOwnerOrCommissioner } from "./lib/auth";
import { customToolUrlError } from "./lib/custom_tool_url";
import { appError } from "./lib/errors";
import { isPrivateAt, revealAtFor } from "./lib/visibility";
import { callProvider, customToolDescription, providerSlug } from "./runtime/tools/custom";

export const MAX_CUSTOM_TOOLS_PER_TEAM = 8;
export const MAX_CUSTOM_TOOL_NAME_CHARS = 60;
export const MAX_CUSTOM_TOOL_DESCRIPTION_CHARS = 600;
export const MAX_CUSTOM_TOOL_URL_CHARS = 2_000;
export const MAX_CUSTOM_TOOL_HEADERS = 8;

const headerPair = v.object({ name: v.string(), value: v.string() });

const toolInput = {
  name: v.string(),
  description: v.string(),
  url: v.string(),
  method: v.union(v.literal("GET"), v.literal("POST")),
  headers: v.array(headerPair),
  jsonPath: v.string(),
};

export type CustomToolView = {
  id: Id<"custom_providers">;
  /** The tool name the model sees: `custom_<slug>`. */
  toolName: string;
  name: string;
  description: string;
  /** The description the model reads, untrusted-data note included. */
  modelDescription: string;
  url: string;
  method: "GET" | "POST";
  /** Header names always; values only when the viewer may edit. */
  headers: Array<{ name: string; value: string | null }>;
  jsonPath: string;
  enabled: boolean;
  createdAt: number;
  /** Epoch ms at which the tool becomes visible to the rest of the league. */
  revealAt: number;
  /** True for league- or platform-wide providers the team inherits (read-only here). */
  inherited: boolean;
};

export type CustomToolsView = {
  tools: CustomToolView[];
  canEdit: boolean;
  /** Own tools this viewer may not see yet, and when the earliest one reveals. */
  hidden: { count: number; revealAt: number | null };
};

function present(row: Doc<"custom_providers">, revealHeaders: boolean, inherited: boolean): CustomToolView {
  return {
    id: row._id,
    toolName: `custom_${providerSlug(row.name)}`,
    name: row.name,
    description: row.config.description ?? "",
    modelDescription: customToolDescription(row),
    url: row.config.url,
    method: row.config.method === "POST" ? "POST" : "GET",
    headers: Object.entries(row.config.headers ?? {}).map(([name, value]) => ({
      name,
      value: revealHeaders ? value : null,
    })),
    jsonPath: row.config.jsonPath ?? "",
    enabled: row.enabled,
    createdAt: row._creationTime,
    revealAt: revealAtFor(row.updatedAt ?? row._creationTime),
    inherited,
  };
}

function validate(input: {
  name: string;
  description: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
}): void {
  const name = input.name.trim();
  if (name.length < 2 || name.length > MAX_CUSTOM_TOOL_NAME_CHARS) {
    throw appError("BAD_REQUEST", `Tool names are 2–${MAX_CUSTOM_TOOL_NAME_CHARS} characters.`);
  }
  if (providerSlug(name) === "provider") {
    throw appError("BAD_REQUEST", "Tool names need at least one letter or digit.");
  }
  if (input.description.length > MAX_CUSTOM_TOOL_DESCRIPTION_CHARS) {
    throw appError(
      "BAD_REQUEST",
      `Descriptions are at most ${MAX_CUSTOM_TOOL_DESCRIPTION_CHARS} characters.`,
    );
  }
  if (input.url.length > MAX_CUSTOM_TOOL_URL_CHARS) {
    throw appError("BAD_REQUEST", "That URL is too long.");
  }
  const urlError = customToolUrlError(input.url);
  if (urlError) throw appError("BAD_REQUEST", urlError);
  if (input.headers.length > MAX_CUSTOM_TOOL_HEADERS) {
    throw appError("BAD_REQUEST", `At most ${MAX_CUSTOM_TOOL_HEADERS} headers.`);
  }
  for (const header of input.headers) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(header.name)) {
      throw appError("BAD_REQUEST", `"${header.name}" is not a valid header name.`);
    }
    if (/[\r\n]/.test(header.value)) {
      throw appError("BAD_REQUEST", `"${header.name}" contains an invalid header value.`);
    }
  }
}

function toConfig(input: {
  description: string;
  url: string;
  method: "GET" | "POST";
  headers: Array<{ name: string; value: string }>;
  jsonPath: string;
}): Doc<"custom_providers">["config"] {
  const headers = Object.fromEntries(
    input.headers.filter((h) => h.name.trim()).map((h) => [h.name.trim(), h.value]),
  );
  const description = input.description.trim();
  const jsonPath = input.jsonPath.trim();
  return {
    url: input.url.trim(),
    method: input.method,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(jsonPath ? { jsonPath } : {}),
    ...(description ? { description } : {}),
  };
}

async function teamRows(ctx: QueryCtx | MutationCtx, teamId: Id<"teams">): Promise<Doc<"custom_providers">[]> {
  // Bounded: MAX_CUSTOM_TOOLS_PER_TEAM, enforced on create.
  return ctx.db
    .query("custom_providers")
    .withIndex("by_teamId", (q) => q.eq("teamId", teamId))
    .take(50);
}

/**
 * Every custom tool that reaches this team's agent: its own rows first, then
 * league-wide and platform-wide providers it inherits. Public within the league
 * once each tool's cooldown has passed; the owner and commissioner see all.
 */
export const listForTeam = query({
  args: { leagueId: v.id("leagues"), teamId: v.id("teams") },
  handler: async (ctx, { leagueId, teamId }): Promise<CustomToolsView> => {
    const access = await requireLeagueRead(ctx, leagueId);
    const team = await ctx.db.get("teams", teamId);
    if (!team || team.leagueId !== leagueId) throw appError("NOT_FOUND", "Team not found in this league.");

    const viewerUserId = access.viewer?.userId ?? null;
    const canEdit =
      viewerUserId !== null && (team.ownerUserId === viewerUserId || access.isCommissioner);

    const now = Date.now();
    const allOwn = await teamRows(ctx, teamId);
    const own = allOwn.filter(
      (row) => !isPrivateAt(row.updatedAt ?? row._creationTime, now, canEdit),
    );
    const hiddenRows = allOwn.filter((row) => !own.includes(row));
    // Bounded: a league has a handful of shared providers at most.
    const leagueWide = (
      await ctx.db
        .query("custom_providers")
        .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
        .take(50)
    ).filter((row) => row.teamId == null);
    const platformWide = (
      await ctx.db
        .query("custom_providers")
        .withIndex("by_leagueId", (q) => q.eq("leagueId", undefined))
        .take(50)
    ).filter((row) => row.teamId == null);

    const sortByName = (a: Doc<"custom_providers">, b: Doc<"custom_providers">) =>
      a.name.localeCompare(b.name);

    return {
      canEdit,
      hidden: {
        count: hiddenRows.length,
        revealAt: hiddenRows.length
          ? Math.min(...hiddenRows.map((row) => revealAtFor(row.updatedAt ?? row._creationTime)))
          : null,
      },
      tools: [
        ...own.sort(sortByName).map((row) => present(row, canEdit, false)),
        ...[...leagueWide, ...platformWide]
          .filter((row) => row.enabled)
          .sort(sortByName)
          .map((row) => present(row, false, true)),
      ],
    };
  },
});

/** Register a new tool for the team. Applies to the next run; not versioned. */
export const create = mutation({
  args: { leagueId: v.id("leagues"), teamId: v.id("teams"), ...toolInput },
  returns: v.id("custom_providers"),
  handler: async (ctx, args) => {
    const access = await requireOwnerOrCommissioner(ctx, args.teamId);
    if (access.team.leagueId !== args.leagueId) throw appError("NOT_FOUND", "Team not found in this league.");
    validate(args);

    const existing = await teamRows(ctx, args.teamId);
    if (existing.length >= MAX_CUSTOM_TOOLS_PER_TEAM) {
      throw appError("BAD_REQUEST", `A team can register at most ${MAX_CUSTOM_TOOLS_PER_TEAM} custom tools.`);
    }
    const slug = providerSlug(args.name.trim());
    if (existing.some((row) => providerSlug(row.name) === slug)) {
      throw appError("CONFLICT", `You already have a tool named custom_${slug}.`);
    }

    return ctx.db.insert("custom_providers", {
      leagueId: args.leagueId,
      teamId: args.teamId,
      name: args.name.trim(),
      slug,
      kind: "http_json",
      config: toConfig(args),
      enabled: true,
      createdByUserId: access.viewer.userId,
    });
  },
});

async function ownRow(
  ctx: MutationCtx,
  toolId: Id<"custom_providers">,
): Promise<{ row: Doc<"custom_providers">; access: Awaited<ReturnType<typeof requireOwnerOrCommissioner>> }> {
  const row = await ctx.db.get("custom_providers", toolId);
  if (!row || !row.teamId) throw appError("NOT_FOUND", "Custom tool not found.");
  const access = await requireOwnerOrCommissioner(ctx, row.teamId);
  return { row, access };
}

/** Edit a tool's definition in place. */
export const update = mutation({
  args: { toolId: v.id("custom_providers"), ...toolInput },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { row } = await ownRow(ctx, args.toolId);
    validate(args);
    const slug = providerSlug(args.name.trim());
    const siblings = await teamRows(ctx, row.teamId!);
    if (siblings.some((other) => other._id !== row._id && providerSlug(other.name) === slug)) {
      throw appError("CONFLICT", `You already have a tool named custom_${slug}.`);
    }
    await ctx.db.patch("custom_providers", row._id, {
      name: args.name.trim(),
      slug,
      config: toConfig(args),
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** Switch a tool on or off without losing its definition. */
export const setEnabled = mutation({
  args: { toolId: v.id("custom_providers"), enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { toolId, enabled }) => {
    const { row } = await ownRow(ctx, toolId);
    await ctx.db.patch("custom_providers", row._id, { enabled });
    return null;
  },
});

/** Delete a tool. Past traces keep their recorded calls; only future runs change. */
export const remove = mutation({
  args: { toolId: v.id("custom_providers") },
  returns: v.null(),
  handler: async (ctx, { toolId }) => {
    const { row } = await ownRow(ctx, toolId);
    await ctx.db.delete("custom_providers", row._id);
    return null;
  },
});

/** The write right, checked from the `test` action (actions have no `db`). */
export const canEditTeam = internalQuery({
  args: { teamId: v.id("teams") },
  returns: v.boolean(),
  handler: async (ctx, { teamId }) => {
    try {
      await requireOwnerOrCommissioner(ctx, teamId);
      return true;
    } catch {
      return false;
    }
  },
});

/**
 * "Test tool": call an unsaved draft (or a saved definition) exactly as the
 * runtime would and return the first 2 KB of what the model would receive.
 * Only the team's editors may fire it — it makes an outbound request with the
 * owner's headers.
 */
export const test = action({
  args: { teamId: v.id("teams"), query: v.optional(v.string()), ...toolInput },
  returns: v.object({
    ok: v.boolean(),
    errors: v.array(v.string()),
    preview: v.union(v.string(), v.null()),
    bytes: v.number(),
    fetchedAt: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const allowed: boolean = await ctx.runQuery(internal.custom_tools.canEditTeam, {
      teamId: args.teamId,
    });
    if (!allowed) throw appError("FORBIDDEN", "Only the team owner or the commissioner may test a tool.");
    validate(args);

    const result = await callProvider(
      { name: args.name.trim(), config: toConfig(args) },
      args.query?.trim() || undefined,
      () => new Date(),
    );
    if (!result.ok) return { ok: false, errors: result.errors, preview: null, bytes: 0, fetchedAt: null };
    return {
      ok: true,
      errors: [],
      preview: result.raw.slice(0, 2_048),
      bytes: result.raw.length,
      fetchedAt: result.fetchedAt,
    };
  },
});
