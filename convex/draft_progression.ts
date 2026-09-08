/**
 * Draft progression (PRD §5.2) — the port of `lib/scheduler/draft-progression.ts`.
 *
 * The old version was polled: every five minutes the tick asked "is a pick
 * window past its close?" and, if so, auto-picked and opened the next one. Here
 * the draft is a **chain of scheduled jobs**: each pick window carries a close
 * job at `now + draftPickSeconds`, and closing it runs the auto-pick and opens
 * the next window. Nothing polls; a 224-pick snake draft is 224 links.
 *
 * Snake: exactly one `draft_pick` window is open at a time, scoped to the team
 * on the clock. Auction: a `auction_nominate` window for the nominating team,
 * then an `auction_bid` window for every team, per lot.
 *
 * Snapshot reuse lives in `internal.windows.open`: a draft window rides the
 * league's newest ready snapshot when it is inside `reuseSnapshotWithinMs`, so
 * a twelve-team draft does not rebuild a 400-player payload every four minutes.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { pickDeadlines, scheduleWindowJobs } from "./scheduling";
import { draftType } from "./schema";

/** Bounded: one lot per roster spot per team (≤ 14 × 16). */
const MAX_LOTS = 256;

type DraftStartResult = {
  order: Id<"teams">[];
  rounds: number;
  picks: number;
  seed: number;
  type: "snake" | "auction";
};

async function rulesOf(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
): Promise<Doc<"league_rules"> | null> {
  return ctx.db
    .query("league_rules")
    .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
    .unique();
}

/**
 * Create a draft window and arm its clock.
 *
 * Draft windows are not week-scoped, so `weekNo` is 0 — that keeps
 * `by_leagueId_label_weekNo_roundNo` usable as the dedupe key, with `roundNo`
 * carrying the overall pick number (snake) or the lot number (auction). The
 * existence check on that index is what makes `openNextPick` idempotent.
 */
async function openDraftWindow(
  ctx: MutationCtx,
  args: {
    leagueId: Id<"leagues">;
    label: string;
    roundNo: number;
    scope: Doc<"windows">["scope"];
    pickSeconds: number;
    now: number;
  },
): Promise<{ windowId: Id<"windows">; created: boolean }> {
  const existing = await ctx.db
    .query("windows")
    .withIndex("by_leagueId_label_weekNo_roundNo", (q) =>
      q
        .eq("leagueId", args.leagueId)
        .eq("label", args.label)
        .eq("weekNo", 0)
        .eq("roundNo", args.roundNo),
    )
    .first();
  if (existing) return { windowId: existing._id, created: false };

  const clock = pickDeadlines(args.now, args.pickSeconds);
  const windowId = await ctx.db.insert("windows", {
    leagueId: args.leagueId,
    type: "draft",
    label: args.label,
    weekNo: 0,
    roundNo: args.roundNo,
    opensAt: clock.opensAt,
    submissionDeadlineAt: clock.submissionDeadlineAt,
    closesAt: clock.closesAt,
    status: "scheduled",
    scope: args.scope,
    runCount: 0,
    terminalRunCount: 0,
  });

  // `opensAt` is now, so this schedules `windows.open` immediately and
  // `windows.close` at the pick clock. The close job *is* the pick clock.
  const jobs = await scheduleWindowJobs(ctx, windowId, args.now);
  await ctx.db.patch("leagues", args.leagueId, { draftJobId: jobs.closeJobId });
  return { windowId, created: true };
}

/** The draft is over: write the default lineups, the schedule, and the season chain. */
async function finalizeDraft(
  ctx: MutationCtx,
  league: Doc<"leagues">,
): Promise<void> {
  // Bounded: the five newest snapshots of one league.
  const recent = await ctx.db
    .query("snapshots")
    .withIndex("by_leagueId_takenAt", (q) => q.eq("leagueId", league._id))
    .order("desc")
    .take(5);
  const snapshot = recent.find((row) => row.status === "ready");

  await ctx.runMutation(internal.draft.finalize, {
    leagueId: league._id,
    snapshotId: snapshot?._id,
  });

  if (league.draftJobId) await ctx.scheduler.cancel(league.draftJobId);
  await ctx.db.patch("leagues", league._id, { draftJobId: undefined });

  // `draft.finalize` wrote the `weeks` grid; now arm the week-rollover chain.
  await ctx.runMutation(internal.weeks.scheduleSeason, { leagueId: league._id });

  // Best-effort narrative (PRD 5.10): an action, so a model outage cannot roll
  // back the finalization it was scheduled from.
  await ctx.scheduler.runAfter(0, internal.commissioner_agent.draftRecap, {
    leagueId: league._id,
  });
}

// ------------------------------------------------------------------ begin

/**
 * Start the draft *and* put the first team on the clock.
 *
 * `commissioner.startDraft` (package E) currently calls `internal.draft.start`,
 * which only writes the board — nothing would ever open a pick window. It must
 * call this instead; the return shape is identical so the swap is one word.
 */
export const begin = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    type: v.optional(draftType),
    scheduledAt: v.optional(v.number()),
    seed: v.optional(v.number()),
  },
  returns: v.object({
    order: v.array(v.id("teams")),
    rounds: v.number(),
    picks: v.number(),
    seed: v.number(),
    type: draftType,
  }),
  handler: async (ctx, args): Promise<DraftStartResult> => {
    const board: DraftStartResult = await ctx.runMutation(internal.draft.start, {
      leagueId: args.leagueId,
      type: args.type,
      scheduledAt: args.scheduledAt,
      seed: args.seed,
    });
    await ctx.runMutation(internal.draft_progression.openNextPick, {
      leagueId: args.leagueId,
    });
    return board;
  },
});

// ---------------------------------------------------------- openNextPick

/**
 * Put the next team on the clock, or finalize when the board is full.
 *
 * A draft scheduled for later arms a job at `draftScheduledAt` instead of
 * opening anything — that replaces the tick's `draftScheduledAt > now` early
 * return.
 */
export const openNextPick = internalMutation({
  args: { leagueId: v.id("leagues"), now: v.optional(v.number()) },
  returns: v.object({
    opened: v.union(v.null(), v.id("windows")),
    finalized: v.boolean(),
    waitingUntil: v.union(v.null(), v.number()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    opened: Id<"windows"> | null;
    finalized: boolean;
    waitingUntil: number | null;
  }> => {
    const now = args.now ?? Date.now();
    const league = await ctx.db.get("leagues", args.leagueId);
    if (!league || league.status !== "drafting") {
      return { opened: null, finalized: false, waitingUntil: null };
    }
    const rules = await rulesOf(ctx, args.leagueId);
    if (!rules) return { opened: null, finalized: false, waitingUntil: null };

    if (league.draftScheduledAt !== undefined && league.draftScheduledAt > now) {
      if (league.draftJobId) await ctx.scheduler.cancel(league.draftJobId);
      const draftJobId = await ctx.scheduler.runAt(
        league.draftScheduledAt,
        internal.draft_progression.openNextPick,
        { leagueId: args.leagueId },
      );
      await ctx.db.patch("leagues", args.leagueId, { draftJobId });
      return { opened: null, finalized: false, waitingUntil: league.draftScheduledAt };
    }

    if (league.draftType === "auction") {
      // The lowest-numbered lot still awaiting a nomination or a bid.
      const pending = await ctx.db
        .query("auction_nominations")
        .withIndex("by_leagueId_status", (q) =>
          q.eq("leagueId", args.leagueId).eq("status", "pending"),
        )
        .take(MAX_LOTS);
      const bidding = await ctx.db
        .query("auction_nominations")
        .withIndex("by_leagueId_status", (q) =>
          q.eq("leagueId", args.leagueId).eq("status", "bidding"),
        )
        .take(MAX_LOTS);
      const lot = [...pending, ...bidding].sort((a, b) => a.lotNo - b.lotNo)[0];
      if (!lot) {
        await finalizeDraft(ctx, league);
        return { opened: null, finalized: true, waitingUntil: null };
      }
      const nominating = lot.status === "pending";
      const { windowId } = await openDraftWindow(ctx, {
        leagueId: args.leagueId,
        label: nominating ? "auction_nominate" : "auction_bid",
        roundNo: lot.lotNo,
        scope: nominating
          ? {
              nominationTeamId: lot.nominatingTeamId,
              lotNo: lot.lotNo,
              draftType: "auction",
              phase: "nominate",
            }
          : { lotNo: lot.lotNo, draftType: "auction", phase: "bid" },
        pickSeconds: rules.draftPickSeconds,
        now,
      });
      return { opened: windowId, finalized: false, waitingUntil: null };
    }

    const pick = await ctx.runQuery(internal.draft.nextPick, { leagueId: args.leagueId });
    if (!pick) {
      await finalizeDraft(ctx, league);
      return { opened: null, finalized: true, waitingUntil: null };
    }

    const { windowId } = await openDraftWindow(ctx, {
      leagueId: args.leagueId,
      label: "draft_pick",
      roundNo: pick.overallNo,
      scope: {
        pickNo: pick.overallNo,
        round: pick.round,
        onTheClockTeamId: pick.teamId,
        draftType: "snake",
      },
      pickSeconds: rules.draftPickSeconds,
      now,
    });
    return { opened: windowId, finalized: false, waitingUntil: null };
  },
});

// ---------------------------------------------------- onPickWindowClosed

/**
 * The pick clock expired: make the platform pick, then advance the draft.
 *
 * Scheduled by `internal.windows.close` for every draft window, so the auto-pick
 * runs in its own transaction after the window's runs have been terminated.
 * `auto: true` skips the positional veto — the draft must never stall — but
 * every other check in `draft.recordPick` still applies.
 */
export const onPickWindowClosed = internalMutation({
  args: { windowId: v.id("windows"), now: v.optional(v.number()) },
  returns: v.object({ autoPicked: v.boolean(), advanced: v.boolean() }),
  handler: async (ctx, args): Promise<{ autoPicked: boolean; advanced: boolean }> => {
    const now = args.now ?? Date.now();
    const window = await ctx.db.get("windows", args.windowId);
    if (!window || window.type !== "draft") return { autoPicked: false, advanced: false };
    const league = await ctx.db.get("leagues", window.leagueId);
    if (!league || league.status !== "drafting") return { autoPicked: false, advanced: false };

    let autoPicked = false;

    if (window.label === "draft_pick") {
      const overallNo = window.scope.pickNo ?? -1;
      const pick = await ctx.db
        .query("draft_picks")
        .withIndex("by_leagueId_overallNo", (q) =>
          q.eq("leagueId", window.leagueId).eq("overallNo", overallNo),
        )
        .first();
      if (pick && pick.playerId === undefined) {
        const best = await ctx.runQuery(internal.draft.bestAvailable, {
          leagueId: window.leagueId,
          teamId: pick.teamId,
          snapshotId: window.snapshotId,
        });
        if (best) {
          const result = await ctx.runMutation(internal.draft.recordPick, {
            leagueId: window.leagueId,
            windowId: window._id,
            teamId: pick.teamId,
            playerId: best.playerId,
            auto: true,
            rationale: "Auto-pick: best available by projection after the pick clock expired.",
            now,
          });
          autoPicked = result.ok;
        }
      }
    } else if (window.label === "auction_nominate") {
      const lot = await ctx.db
        .query("auction_nominations")
        .withIndex("by_leagueId_lotNo", (q) =>
          q.eq("leagueId", window.leagueId).eq("lotNo", window.roundNo),
        )
        .first();
      if (lot && lot.status === "pending") {
        // Nobody nominated: the platform nominates the best available at $1.
        const best = await ctx.runQuery(internal.draft.bestAvailable, {
          leagueId: window.leagueId,
          teamId: lot.nominatingTeamId,
          snapshotId: window.snapshotId,
        });
        if (best) {
          const result = await ctx.runMutation(internal.draft.nominate, {
            leagueId: window.leagueId,
            windowId: window._id,
            teamId: lot.nominatingTeamId,
            playerId: best.playerId,
            openingBid: 1,
          });
          autoPicked = result.ok;
        }
      }
    } else if (window.label === "auction_bid") {
      const lot = await ctx.db
        .query("auction_nominations")
        .withIndex("by_leagueId_lotNo", (q) =>
          q.eq("leagueId", window.leagueId).eq("lotNo", window.roundNo),
        )
        .first();
      if (lot && lot.status === "bidding") {
        // Sealed bids resolve here; `resolveLot` also creates the next lot.
        await ctx.runMutation(internal.draft.resolveLot, { nominationId: lot._id, now });
      }
    }

    const next = await ctx.runMutation(internal.draft_progression.openNextPick, {
      leagueId: window.leagueId,
      now,
    });
    return { autoPicked, advanced: next.opened !== null || next.finalized };
  },
});
