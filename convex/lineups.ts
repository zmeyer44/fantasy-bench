/**
 * Lineups — validation, commit and the safety autopilot (PRD §5.4).
 *
 * `lineups` is append-only versioned history: the live lineup for a team-week is
 * the highest `version` on `by_teamId_weekNo_version`, and nothing is ever
 * updated in place. Three entry points:
 *
 *  - `commit` — the `set_lineup` write tool and every platform writer. With an
 *    `agentCtx` it validates against the *window's snapshot* (not live tables),
 *    so a replay against the stored snapshot produces the same answer as the
 *    original run (PRD 6.6), and records the action for idempotency.
 *  - `applySafetyAutopilot` — the fallback `windows.close` applies when a run
 *    left a starting slot empty, stale or unplayable.
 *  - `current` / `validate` — reads the runtime needs before it writes.
 *
 * The rules themselves live in `convex/lib/lineup_pure.ts`; this file is only
 * the database half.
 */
import { v } from "convex/values";

import type { LineupSlot, SnapshotPayload } from "../lib/snapshot/types";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { agentCtxValidator, fail, withAgentAction, type AgentCtx } from "./lib/agent_action";
import { computeOptimalLineup, planSafetyAutopilot, validateLineup } from "./lib/lineup_pure";
import { lineupSlot, lineupSource } from "./schema";
import { readPayload } from "./snapshot";

/** The stored slot shape (`playerId` is a real id or null), as the schema defines it. */
export type StoredSlot = { slot: string; playerId: Id<"players"> | null };

/** Pure lineup code speaks in plain strings; ids are strings on the wire anyway. */
function toPureSlots(slots: StoredSlot[]): LineupSlot[] {
  return slots.map((s) => ({ slot: s.slot, playerId: s.playerId }));
}

function toStoredSlots(slots: LineupSlot[]): StoredSlot[] {
  return slots.map((s) => ({ slot: s.slot, playerId: (s.playerId as Id<"players"> | null) ?? null }));
}

// ------------------------------------------------------------------- reads

/** Latest lineup version for a team-week, or null. */
export async function currentLineup(
  ctx: QueryCtx,
  teamId: Id<"teams">,
  weekNo: number,
): Promise<Doc<"lineups"> | null> {
  return ctx.db
    .query("lineups")
    .withIndex("by_teamId_weekNo_version", (q) => q.eq("teamId", teamId).eq("weekNo", weekNo))
    .order("desc")
    .first();
}

export const current = internalQuery({
  args: { teamId: v.id("teams"), weekNo: v.number() },
  returns: v.union(
    v.null(),
    v.object({
      lineupId: v.id("lineups"),
      version: v.number(),
      slots: v.array(lineupSlot),
      source: lineupSource,
      setByRunId: v.union(v.null(), v.id("runs")),
    }),
  ),
  handler: async (ctx, { teamId, weekNo }) => {
    const row = await currentLineup(ctx, teamId, weekNo);
    if (!row) return null;
    return {
      lineupId: row._id,
      version: row.version,
      slots: row.slots,
      source: row.source,
      setByRunId: row.setByRunId ?? null,
    };
  },
});

/** The payload frozen at a window's open, or null when the window has no snapshot. */
export async function payloadForWindow(
  ctx: QueryCtx,
  windowId: Id<"windows">,
): Promise<SnapshotPayload | null> {
  const window = await ctx.db.get("windows", windowId);
  if (!window?.snapshotId) return null;
  return readPayload(ctx, window.snapshotId);
}

/**
 * Dry-run the same validation `commit` applies, so a write tool can report the
 * errors without spending its one write.
 */
export const validate = internalQuery({
  args: {
    teamId: v.id("teams"),
    windowId: v.id("windows"),
    slots: v.array(lineupSlot),
    now: v.optional(v.number()),
  },
  returns: v.object({
    ok: v.boolean(),
    errors: v.array(v.string()),
    warnings: v.array(v.string()),
  }),
  handler: async (ctx, { teamId, windowId, slots, now }) => {
    const snapshot = await payloadForWindow(ctx, windowId);
    if (!snapshot) {
      return { ok: false, errors: ["That window has no snapshot to validate against."], warnings: [] };
    }
    const result = validateLineup({
      snapshot,
      teamId,
      slots: toPureSlots(slots),
      now: new Date(now ?? Date.now()),
    });
    return {
      ok: result.ok,
      errors: result.ok ? [] : result.errors,
      warnings: result.warnings,
    };
  },
});

// ------------------------------------------------------------------ writes

/** Append the next version for a team-week. Never updates in place. */
export async function insertLineupVersion(
  ctx: MutationCtx,
  args: {
    teamId: Id<"teams">;
    leagueId: Id<"leagues">;
    weekNo: number;
    slots: StoredSlot[];
    source: Doc<"lineups">["source"];
    runId?: Id<"runs"> | null;
  },
): Promise<{ lineupId: Id<"lineups">; version: number }> {
  const previous = await currentLineup(ctx, args.teamId, args.weekNo);
  const version = (previous?.version ?? 0) + 1;
  const lineupId = await ctx.db.insert("lineups", {
    teamId: args.teamId,
    leagueId: args.leagueId,
    weekNo: args.weekNo,
    version,
    slots: args.slots,
    source: args.source,
    setByRunId: args.runId ?? undefined,
  });
  return { lineupId, version };
}

const commitResult = v.union(
  v.object({
    ok: v.literal(true),
    lineupId: v.id("lineups"),
    version: v.number(),
    warnings: v.array(v.string()),
  }),
  v.object({ ok: v.literal(false), errors: v.array(v.string()) }),
);

/**
 * `set_lineup`. With `agentCtx` the slots are validated against the window's
 * snapshot and the call is idempotent on `(runId, toolCallId)`; without it the
 * caller is the platform (draft defaults, carryover, the seed) and the slots go
 * in as given.
 */
export const commit = internalMutation({
  args: {
    teamId: v.id("teams"),
    weekNo: v.number(),
    slots: v.array(lineupSlot),
    source: lineupSource,
    runId: v.optional(v.id("runs")),
    agentCtx: v.optional(agentCtxValidator),
    now: v.optional(v.number()),
  },
  returns: commitResult,
  handler: async (ctx, args) => {
    const agentCtx = args.agentCtx as AgentCtx | undefined;
    return withAgentAction(
      ctx,
      agentCtx,
      {
        actionType: "set_lineup",
        payload: { teamId: args.teamId, weekNo: args.weekNo, slots: args.slots },
      },
      async () => {
        const team = await ctx.db.get("teams", args.teamId);
        if (!team) return fail(`Team ${args.teamId} does not exist.`);

        let warnings: string[] = [];
        if (agentCtx) {
          const snapshot = await payloadForWindow(ctx, agentCtx.windowId);
          if (!snapshot) return fail("That window has no snapshot to validate against.");
          const validation = validateLineup({
            snapshot,
            teamId: args.teamId,
            slots: toPureSlots(args.slots),
            now: new Date(args.now ?? Date.now()),
          });
          if (!validation.ok) return fail(...validation.errors);
          warnings = validation.warnings;
        }

        const { lineupId, version } = await insertLineupVersion(ctx, {
          teamId: args.teamId,
          leagueId: team.leagueId,
          weekNo: args.weekNo,
          slots: args.slots,
          source: args.source,
          runId: args.runId ?? agentCtx?.runId ?? null,
        });
        return { ok: true as const, lineupId, version, warnings };
      },
    );
  },
});

/**
 * Safety autopilot (PRD 5.4 fallbacks), applied by `windows.close`.
 *
 * Idempotent by construction: a second call finds nothing to fill and writes no
 * new version. The one exception is a team-week with no stored lineup at all,
 * where the carried-over shape is persisted once so the week always has a row.
 */
export const applySafetyAutopilot = internalMutation({
  args: {
    snapshotId: v.id("snapshots"),
    teamId: v.id("teams"),
    weekNo: v.number(),
    runId: v.optional(v.id("runs")),
    now: v.optional(v.number()),
  },
  returns: v.object({
    changed: v.boolean(),
    slots: v.array(lineupSlot),
    filledSlots: v.array(v.string()),
    version: v.union(v.null(), v.number()),
  }),
  handler: async (ctx, args) => {
    const team = await ctx.db.get("teams", args.teamId);
    const snapshot = await readPayload(ctx, args.snapshotId);
    if (!team || !snapshot) {
      return { changed: false, slots: [], filledSlots: [], version: null };
    }
    const snapshotTeam = snapshot.teams.find((t) => t.id === args.teamId);
    if (!snapshotTeam) return { changed: false, slots: [], filledSlots: [], version: null };

    const stored = await currentLineup(ctx, args.teamId, args.weekNo);
    const base = stored?.slots?.length ? toPureSlots(stored.slots) : (snapshotTeam.lineup ?? []);

    const plan = planSafetyAutopilot({
      snapshot,
      teamId: args.teamId,
      base,
      now: new Date(args.now ?? Date.now()),
    });
    const slots = toStoredSlots(plan.slots);

    if (plan.filledSlots.length === 0) {
      // Nothing to do. With no stored lineup at all, persist the carried-over
      // shape once so the week always has a row; otherwise leave history alone.
      if (!stored) {
        const written = await insertLineupVersion(ctx, {
          teamId: args.teamId,
          leagueId: team.leagueId,
          weekNo: args.weekNo,
          slots,
          source: "carryover",
          runId: args.runId ?? null,
        });
        return { changed: true, slots, filledSlots: [], version: written.version };
      }
      return {
        changed: false,
        slots: stored.slots,
        filledSlots: [],
        version: stored.version,
      };
    }

    const written = await insertLineupVersion(ctx, {
      teamId: args.teamId,
      leagueId: team.leagueId,
      weekNo: args.weekNo,
      slots,
      source: "autopilot",
      runId: args.runId ?? null,
    });
    return { changed: true, slots, filledSlots: plan.filledSlots, version: written.version };
  },
});

/**
 * The best legal lineup from a team's roster in a snapshot — what `draft.finalize`
 * writes as everyone's week-1 default, and what the film room compares against.
 */
export const optimal = internalQuery({
  args: { snapshotId: v.id("snapshots"), teamId: v.id("teams"), now: v.optional(v.number()) },
  returns: v.array(lineupSlot),
  handler: async (ctx, { snapshotId, teamId, now }) => {
    const snapshot = await readPayload(ctx, snapshotId);
    if (!snapshot) return [];
    return toStoredSlots(
      computeOptimalLineup({
        snapshot,
        teamId,
        now: now === undefined ? undefined : new Date(now),
      }),
    );
  },
});
