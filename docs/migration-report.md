# Convex migration report

Fantasy Bench moved from Next.js + tRPC + Drizzle/PostgreSQL + Vercel cron to Next.js (frontend
only) + Convex (schema, functions, scheduling, Workpool, ledger). This report closes the plan in
`docs/migration-plan.md`. Verified API notes: `docs/CONVEX_NOTES.md`. Phase verification detail:
`docs/verification/phase2.md`, `docs/verification/phase5.md`.

Deployments: dev `dev:tidy-peacock-243` (`https://tidy-peacock-243.convex.cloud`, selected in
`.env.local`); load test `dev:content-ant-382` (never selected; targeted with per-command overrides).
Auth: Convex Auth (`@convex-dev/auth`, Password provider), set up with `npx @convex-dev/auth`.

## 1. Inventory — complete

| Inventory row (plan §2) | Count | Status |
|---|---|---|
| tRPC procedures → Convex functions | 65 (39 queries, 26 mutations) | ✅ all mapped; 40 read procedures covered by `convex/parity.test.ts` |
| Server-component pages → Convex reads | 35 pages | ✅ `preloadQuery`/`usePreloadedQuery` for live pages, `fetchQuery` otherwise |
| Client components with tRPC hooks → Convex hooks | 18 | ✅ all on `useMutation`/`useQuery`; forum votes optimistic |
| Drizzle tables → Convex tables | 48 → 54 (+ Convex Auth tables) | ✅ `convex/schema.ts`, 130 indexes + 3 search indexes |
| Query-time SQL aggregations → rollups | 31 | ✅ `team_week_rollups`, `model_week_rollups`, `league_week_rollups`, `team_standings`, `team_week_metrics`, denormalized counters |
| Cron handlers / route handlers / scripts | 2 crons, 7 routes, 6 scripts | ✅ scheduled functions + `convex/crons.ts`; Vercel cron, tick, execute route, tRPC and better-auth routes deleted |
| Runtime database write sites | 78 | ✅ one internal mutation per service entry point, idempotent on `(runId, toolCallId)` |
| Postgres / Drizzle / tRPC / better-auth / Vercel cron | — | ✅ removed in cleanup (see §6) |

## 2. Architecture as built

- **Reads**: reactive queries with an index and a bound on every read; paginated lists use
  `paginationOptsValidator`. Trace viewer subscribes to the run document, pages `run_steps`, and
  loads oversized tool results lazily from `run_step_payloads`. Draft board, negotiation feed,
  forum, and cost dashboards are live subscriptions; all polling code was deleted.
- **Writes**: public mutations enforce the tRPC authorization ladder (`convex/lib/auth.ts`).
  Agent-facing writes are internal mutations that take an `agentCtx` and record `run_actions`
  in the same transaction as the domain write (the idempotency key).
- **Ledger**: `internal.ledger.recordStep` is the only writer of `usage_events` and upserts the
  three rollup tables in the same mutation. `internal.runs.persistStep` calls it via
  `ctx.runMutation` so the step document, the usage event and the rollups commit together.
  `ledger.verify` (commissioner action) pages events and compares them with the rollups.
- **Scheduling**: windows own their `openJobId`/`closeJobId` (scheduled mutations); week rollover
  and config-unlock jobs live on `weeks`; draft picks chain through pick-window close jobs;
  `season.tickAll` and `ingest.tick` are crons that schedule per-league work.
- **Runtime**: `internal.runtime.execute.executeRun` runs in the **default Convex runtime**
  (probe on the deployment: `setTimeout`, `AbortController` and the AI SDK tool loop all work
  there; the docs' supported-API list omits `setTimeout`). One Workpool (`runPool`) dispatches
  runs; `onComplete` is the only writer of terminal status and enqueues the fallback-model run.
  Retries resume from `lastPersistedStep + 1` and never re-execute a tool call that has a
  `run_actions` row.

## 3. Verification results

| Check (brief §11) | Result |
|---|---|
| Parity tests | 40/40 read procedures return the old shapes on the golden dataset; 2 benign undocumented deviations (`leagues.get` is a superset; `forum.karma` renames `id`→`teamId`) |
| Scheduler test | window opening in 10 s / closing in 40 s driven only by scheduled jobs: snapshot bound, one run per team, all terminal, autopilot filled the empty slot |
| Resume test | crash after step 3 → steps 0–2 kept, no duplicate `run_steps`/`run_actions`/`usage_events`, run completes from step 3 |
| Budget test | tiny per-run budget → `budget_exhausted`, fallback lineup applied at close |
| Lock test | `set_lineup` on a locked slot rejected, other slots untouched |
| Ledger reconciliation | rollups equal event sums in tests, including a replay of the 194 golden usage events |
| Limits | 57 public queries × 311 calls on a 50-league, 17-week dataset (484k documents): 0 read-limit errors, max warm latency 298 ms |
| Load | 600 runs (50 leagues × 12) at `maxParallelism: 24`: all 600 succeeded, last run finished 131 s after open, 0 deadline misses (45× margin), 261 runs/min |
| End-to-end | simulated week vs golden: all 12 final lineups match player-for-player; run/status/outcome counts, actions, waivers (24/2/22), threads (6), forum posts (4), transactions match; differences are explained (a Postgres thread-race that Convex fixes, scheduling-dependent replies, waiver tie-break) |

Convex test suite: 530+ tests across 33 files (`npm test`). Repo: typecheck, lint and `next build` clean.

## 4. Bugs found by verification and fixed

1. **Silent step loss under concurrency (high).** The AI SDK swallows errors thrown from
   `onStepEnd`, so a `persistStep` failure (write conflicts when twelve runs hit the same rollup
   rows at once) dropped the step, its usage event and its trace silently. Fix: persistence is
   retried with backoff; if it still fails the run is aborted and rethrown so the Workpool retries
   and resumes. Re-verified with 24 concurrent runs: 142/142 steps persisted, contiguous.
2. **`runCount` rollup** counted only steps with index 0; a resumed run starts later. Now counted on
   a run's first recorded event.
3. **`views.team` duplicated RB1/WR1** by looking slots up by label; now positional.
4. **Postgres thread race** (a `propose_trade` lost to a unique-index race in the old system) no
   longer occurs — Convex's transactional thread upsert makes the count deterministic.

## 5. Workpool parallelism

`maxParallelism: 24`, `retryActionsByDefault: true`, 3 attempts with 2 s exponential backoff.
The load test ran at the cap the whole time (≈24 in flight) and still finished 600 mock runs in
138 s against a 100-minute window. At a real provider's ~60 s per run the pool clears ≈2,400 runs
per window (≈200 leagues) before the deadline is at risk, well under the Pro guidance of 100 total
parallelism. Batching teams per job was rejected because it would break the one-job-per-run resume
contract. Revisit past ~200 in-season leagues.

## 6. Cleanup

Removed 158 files (~82k lines): `lib/db`, `lib/services`, `lib/agent`, `lib/scheduler`,
`lib/providers`, `lib/auth`, `lib/trpc`, `lib/env.ts`, the Postgres test suite and scripts,
`drizzle.config.ts`, `vercel.json`, the `api/cron`, `api/runs`, `api/trpc`, `api/auth` route
handlers, and 12 dependencies (`drizzle-orm`, `drizzle-kit`, `postgres`, `@trpc/*`,
`@tanstack/react-query`, `superjson`, `better-auth`, `dotenv`, `@types/diff`, `@ai-sdk/react`).
Pure modules shared by the UI and functions stayed (`lib/time.ts`, `lib/models.ts`,
`lib/snapshot/types.ts`); the scoring table moved to `convex/lib/scoring_table.ts`. The `legacyId`
field was stripped from 8,765 existing documents by a byte-aware, self-rescheduling migration
before the schema push, then removed from the schema; the seed importer now keeps its id map in
`.cache/seed-map.<deployment>.json` and stays idempotent. `seed.reset`/`clearTable` delete one
byte-aware batch per invocation (100 documents for heavy tables, 1,000 otherwise).
`tests/golden/postgres-week1/` is kept as the parity fixture.

## 7. Open issues

- **Dev deployment data**: runs executed before fix §4.1 (the Phase 5 e2e league) have gaps and an
  inconsistent `runCount`; `ledger.verify` reports them. Re-seed (`npm run seed:convex` after
  `seed.reset`) to clear.
- **Commissioner weekly recap** is not idempotent per week if `runWeekly` is invoked twice
  manually; the scheduler invokes it once per finalize.
- **Hot-row contention**: every run's step touches the same league-week and global model-week
  rollup rows. Retries absorb it at 24-way parallelism; at higher parallelism, shard the global
  model row.
- **Silent truncations** (documented in `convex/limits.test.ts`): waiver results derive counts
  from a 200-claims-per-week window, the draft board stops at 300 picks, run export inlines at
  most 64 steps.
- **Cold latency** of `ledger.leagueDashboard`/`benchmark` is 1.3–1.5 s on the 50-league dataset
  (warm < 300 ms).
- **`CONVEX_DEPLOYMENT=… npx convex dev --once` rewrites `.env.local`**; use `env`/`run` with the
  override or a separate `--env-file` for the load-test deployment.
- `ingest` crons are disabled on the dev deployment (`INGEST_DISABLED=1`) to keep fixtures stable;
  remove the variable to go live. `AI_GATEWAY_API_KEY` is not set on dev; teams run `mock/scripted`.
- v1.1 items remain unbuilt: injury-triggered re-runs, config-version counterfactual replay, BYOK,
  cross-league leaderboards.
