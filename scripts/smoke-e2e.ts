/**
 * End-to-end smoke: open a window on the demo league, execute every team's run on
 * the mock model, close the window, and print what the platform recorded.
 *
 *   npx tsx --env-file-if-exists=.env.local scripts/smoke-e2e.ts [window-label]
 */
import { and, eq } from "drizzle-orm";

import { db, pgClient } from "@/lib/db";
import { leagues, runs } from "@/lib/db/schema";
import { claimRun, executeRun } from "@/lib/agent/execute";
import { closeWindowNow, openWindowNow } from "@/lib/scheduler";

const labels = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["lineup_sun_early"];

async function runWindow(league: { id: string }, label: string) {
  const now = new Date();
  const opened = await openWindowNow(league.id, label, { weekNo: 1, roundNo: 1, now });
  console.log(`opened window ${label}:`, opened);
  const windowId = (opened as { windowId?: string; id?: string }).windowId ?? (opened as { id?: string }).id;
  if (!windowId) throw new Error(`openWindowNow returned no window id: ${JSON.stringify(opened)}`);

  const pending = await db
    .select({ id: runs.id, teamId: runs.teamId })
    .from(runs)
    .where(and(eq(runs.windowId, windowId), eq(runs.status, "pending")));
  console.log(`pending runs: ${pending.length}`);

  const started = Date.now();
  const results = await Promise.all(
    pending.map(async (run) => {
      const claim = await claimRun(run.id);
      if (!claim.claimed) return { runId: run.id, status: "not_claimed" };
      const result = await executeRun(run.id);
      return { runId: run.id, status: result.status, outcome: result.outcome, steps: result.stepCount, cost: result.totalCostUsd };
    }),
  );
  console.log(`executed ${results.length} runs in ${Date.now() - started}ms`);
  console.table(results);

  const closed = await closeWindowNow(windowId, { now: new Date() });
  console.log("closed:", closed);

  const [steps] = await pgClient<{ n: string }[]>`select count(*)::text n from run_steps rs join runs r on r.id = rs.run_id where r.window_id = ${windowId}`;
  const [events] = await pgClient<{ n: string; usd: string }[]>`select count(*)::text n, coalesce(sum(cost_usd),0)::text usd from usage_events ue join runs r on r.id = ue.run_id where r.window_id = ${windowId}`;
  const [lineupRows] = await pgClient<{ n: string }[]>`select count(*)::text n from lineups where set_by_run_id in (select id from runs where window_id = ${windowId})`;
  const [posts] = await pgClient<{ n: string }[]>`select count(*)::text n from forum_posts where league_id = ${league.id}`;
  const [rationales] = await pgClient<{ n: string }[]>`select count(*)::text n from runs where window_id = ${windowId} and rationale is not null`;
  console.log({ runSteps: steps.n, usageEvents: events.n, usd: events.usd, lineupsSetByRuns: lineupRows.n, forumPosts: posts.n, rationales: rationales.n });
  console.log(`trace: http://localhost:3000/leagues/${league.id}/traces/${results[0]?.runId}`);
}

async function main() {
  const league = await db.query.leagues.findFirst({ where: eq(leagues.slug, "demo-league") });
  if (!league) throw new Error("demo league missing — run `npm run db:seed-demo` first");
  for (const label of labels) {
    if (label === "commissioner") {
      const { runWeeklyCommissionerTasks } = await import("@/lib/services/commissioner-agent");
      const results = await runWeeklyCommissionerTasks(league.id, 1);
      console.log("commissioner tasks:", results.map((r) => ({ task: r.task, posts: r.postIds.length, scripted: r.scripted, cost: r.costUsd })));
      continue;
    }
    console.log(`\n=== ${label} ===`);
    await runWindow(league, label);
  }
  const [threads] = await pgClient<{ n: string }[]>`select count(*)::text n from threads where league_id = ${league.id}`;
  const [trades] = await pgClient<{ n: string }[]>`select count(*)::text n from trades where league_id = ${league.id}`;
  const [claims] = await pgClient<{ n: string; won: string }[]>`select count(*)::text n, count(*) filter (where status = 'won')::text won from waiver_claims where league_id = ${league.id}`;
  const [posts] = await pgClient<{ n: string }[]>`select count(*)::text n from forum_posts where league_id = ${league.id}`;
  console.log({ threads: threads.n, trades: trades.n, waiverClaims: claims.n, claimsWon: claims.won, forumPosts: posts.n });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pgClient.end({ timeout: 5 }));
