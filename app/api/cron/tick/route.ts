/**
 * `/api/cron/tick` — every 5 minutes (see vercel.json).
 *
 * Vercel's cron sends `Authorization: Bearer $CRON_SECRET`, which is the only
 * thing that may trigger this route. The handler is a thin wrapper: all logic
 * lives in `lib/scheduler/tick`.
 *
 * Dispatch of pending runs is handed to `after()` from `next/server`, which is
 * the documented serverless `waitUntil` wrapper — per
 * `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md`:
 * "Using `after` in a serverless context requires waiting for asynchronous tasks
 * to finish after the response has been sent. In Next.js and Vercel, this is
 * achieved using a primitive called `waitUntil(promise)`". That lets the cron
 * response return immediately while the fan-out keeps the invocation alive.
 */
import { after, type NextRequest } from "next/server";

import { runTick } from "@/lib/scheduler/tick";

/** Fluid Compute wall clock for the tick itself (PRD 6.3). */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

function authorized(request: NextRequest): boolean {
  const expected = process.env.CRON_SECRET ?? "dev-cron-secret";
  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${expected}`;
}

async function handle(request: NextRequest): Promise<Response> {
  if (!authorized(request)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const leagueId = request.nextUrl.searchParams.get("leagueId") ?? undefined;
  try {
    const report = await runTick({
      leagueId,
      // `after` runs the fan-out once the response has been sent.
      schedule: (task) => after(task),
    });
    return Response.json({ ok: true, ...report });
  } catch (err) {
    console.error("[cron/tick] failed", err);
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  return handle(request);
}

export async function POST(request: NextRequest): Promise<Response> {
  return handle(request);
}
