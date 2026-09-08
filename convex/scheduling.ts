/**
 * Window job scheduling (migration plan §2.4 / §4).
 *
 * The five-minute Vercel cron is gone. A window carries its own two scheduled
 * functions — `internal.windows.open` at `opensAt` and `internal.windows.close`
 * at `closesAt` — whose ids live on the row (`openJobId` / `closeJobId`) so a
 * reschedule can cancel exactly what it replaces.
 *
 * Everything here runs inside a mutation, which is what makes it safe:
 * "Scheduling from a mutation is transactional: if the mutation commits, the job
 * is guaranteed scheduled; if it rolls back, nothing is scheduled"
 * (docs/CONVEX_NOTES.md §5). So a window row and its jobs are created or not
 * created together — there is no state where a window exists with no clock.
 *
 * Cancellation is best-effort by design: `cancel` on a job that already ran is a
 * no-op, and `open`/`close` are both idempotent on `windows.status`, so a stale
 * duplicate job can never double-open or double-close a window.
 */
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

export type WindowJobIds = {
  openJobId: Id<"_scheduled_functions"> | undefined;
  closeJobId: Id<"_scheduled_functions"> | undefined;
};

/** Cancel whatever this window currently has scheduled. Safe on already-run jobs. */
export async function cancelWindowJobs(
  ctx: MutationCtx,
  window: Doc<"windows">,
): Promise<void> {
  if (window.openJobId) await ctx.scheduler.cancel(window.openJobId);
  if (window.closeJobId) await ctx.scheduler.cancel(window.closeJobId);
}

/**
 * (Re)schedule a window's open and close jobs and store their ids.
 *
 * Rules:
 *  - An `open` job is only scheduled while the window is still `scheduled`. A
 *    window that already opened does not get a second open (the mutation would
 *    refuse anyway, but not scheduling it keeps `_scheduled_functions` clean).
 *  - `opensAt` in the past + status `scheduled` means we are late (a league
 *    created mid-week, a commissioner moving a window backwards): open now.
 *  - A `close` job is scheduled unless the window is already `closed`; a
 *    `closesAt` in the past closes now, which is what runs the fallbacks.
 */
export async function scheduleWindowJobs(
  ctx: MutationCtx,
  windowId: Id<"windows">,
  now: number = Date.now(),
): Promise<WindowJobIds> {
  const window = await ctx.db.get("windows", windowId);
  if (!window) return { openJobId: undefined, closeJobId: undefined };

  await cancelWindowJobs(ctx, window);

  let openJobId: Id<"_scheduled_functions"> | undefined;
  if (window.status === "scheduled") {
    openJobId =
      window.opensAt <= now
        ? await ctx.scheduler.runAfter(0, internal.windows.open, { windowId })
        : await ctx.scheduler.runAt(window.opensAt, internal.windows.open, { windowId });
  }

  let closeJobId: Id<"_scheduled_functions"> | undefined;
  if (window.status !== "closed") {
    closeJobId =
      window.closesAt <= now
        ? await ctx.scheduler.runAfter(0, internal.windows.close, { windowId })
        : await ctx.scheduler.runAt(window.closesAt, internal.windows.close, { windowId });
  }

  await ctx.db.patch("windows", windowId, { openJobId, closeJobId });
  return { openJobId, closeJobId };
}

/**
 * Move a window's clock and re-arm its jobs in one transaction.
 *
 * Used by `internal.windows.rescheduleForLeague` when the commissioner edits
 * `league_rules.windowOverrides`, and by the admin helpers.
 */
export async function rescheduleWindow(
  ctx: MutationCtx,
  windowId: Id<"windows">,
  times: {
    opensAt?: number;
    closesAt?: number;
    submissionDeadlineAt?: number;
    now?: number;
  } = {},
): Promise<WindowJobIds> {
  const window = await ctx.db.get("windows", windowId);
  if (!window) return { openJobId: undefined, closeJobId: undefined };

  const opensAt = times.opensAt ?? window.opensAt;
  const closesAt = times.closesAt ?? window.closesAt;
  const submissionDeadlineAt =
    times.submissionDeadlineAt ??
    (times.closesAt !== undefined
      ? // Keep the template's lead time when only the close moved.
        Math.max(opensAt, closesAt - (window.closesAt - window.submissionDeadlineAt))
      : window.submissionDeadlineAt);

  if (
    opensAt !== window.opensAt ||
    closesAt !== window.closesAt ||
    submissionDeadlineAt !== window.submissionDeadlineAt
  ) {
    await ctx.db.patch("windows", windowId, { opensAt, closesAt, submissionDeadlineAt });
  }
  return scheduleWindowJobs(ctx, windowId, times.now ?? Date.now());
}

/**
 * The pick-clock deadlines for a draft window (port of
 * `draft_progression.pickDeadlines`): a 4-minute clock cannot
 * carry the 10-minute submission lead the weekly windows use, so the lead is a
 * quarter of the clock, capped at a minute.
 */
export function pickDeadlines(
  now: number,
  pickSeconds: number,
): { opensAt: number; closesAt: number; submissionDeadlineAt: number } {
  const closesAt = now + pickSeconds * 1000;
  const lead = Math.min(60_000, Math.floor(pickSeconds * 1000 * 0.25));
  return { opensAt: now, closesAt, submissionDeadlineAt: Math.max(now, closesAt - lead) };
}
