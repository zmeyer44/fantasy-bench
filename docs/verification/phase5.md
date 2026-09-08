# Phase 5 verification — load test and end-to-end week

Brief §11, the two checks `docs/migration-plan.md` §7 step 5 asks for:

1. **Load** — 600 agent runs at Workpool `maxParallelism: 24`, on the 50-league load-test
   deployment, must all finish before their window's `submissionDeadlineAt`; if not, raise
   parallelism or batch teams per job.
2. **End-to-end** — a simulated week 1 driven through the Convex scheduler, diffed against the
   golden state recorded from the Postgres system before Phase 2
   (`tests/golden/postgres-week1/*.json`).

Scripts (all three are Node programs, none of them touch `convex/`):

| Script | What it does |
|---|---|
| `scripts/loadtest-run.ts` | opens one week-1 lineup window in all 50 load-test leagues at once, waits for 600 terminal runs, closes them, reports throughput and the status mix |
| `scripts/e2e-week.ts` | imports the golden league's **pre-run** tables under a new slug and drives `lineup_sun_early` → `waiver` → `trade_a` → `commissioner_agent:runWeekly` |
| `scripts/golden-diff.ts` | compares the resulting league with the golden dump on behaviour-level invariants and exits non-zero on an unexplained difference |

**Result in one line:** the scheduler and the Workpool pass (600/600 succeeded, 45× inside the
deadline, `maxParallelism: 24` is right); the *ledger* does not — the runtime records fewer
`run_steps` / `usage_events` than the runs claim, and the rollups' `runCount` is consequently
wrong. Three defects are described in §4.

---

## 0. How to reproduce

```bash
# --- Part A: load test (deployment dev:content-ant-382, never selected) -------
CONVEX_DEPLOYMENT=dev:content-ant-382 npx convex env list          # check before every push/seed
CONVEX_DEPLOYMENT=dev:content-ant-382 npm run convex:push          # see the WARNING below
CONVEX_DEPLOYMENT=dev:content-ant-382 npx convex env set INGEST_DISABLED 1
CONVEX_DEPLOYMENT=dev:content-ant-382 npx convex env set COMMISSIONER_MODEL_ID mock/scripted
CONVEX_DEPLOYMENT=dev:content-ant-382 npx convex env remove RUN_DISPATCH   # Phase 2 leaves it =skip

npx tsx --env-file=.env.loadtest scripts/loadtest-run.ts patch-models
npx tsx --env-file=.env.loadtest scripts/loadtest-run.ts check
# a window can only be measured once (dispatch skips teams that already have a run);
# `lineup_thu` and `lineup_sun_late` are used up on this fixture — next clean label is lineup_mon
npx tsx --env-file=.env.loadtest scripts/loadtest-run.ts run --leagues=50 --week=1 --label=lineup_sun_late

CONVEX_DEPLOYMENT=dev:content-ant-382 npx convex env set RUN_DISPATCH skip  # restore for Phase 2

# --- Part B: end-to-end week (main dev deployment dev:tidy-peacock-243) -------
npm run seed:convex                                     # already applied; golden data present
npx tsx --env-file=.env.local scripts/e2e-week.ts       # import + drive (~90 s)
npx tsx --env-file=.env.local scripts/golden-diff.ts    # exits 1 on an unexplained difference
```

Extra `loadtest-run.ts` commands: `counts [--tables=a,b]`, `resample` (re-read the same 600 runs
after the fact), `close` (close the target windows without running anything — the cleanup for an
interrupted `run`).

> **WARNING — `npx convex dev --once` rewrites `.env.local`.**
> `CONVEX_DEPLOYMENT=dev:content-ant-382 npm run convex:push` pushed to the right deployment **and
> then wrote `CONVEX_DEPLOYMENT`, `NEXT_PUBLIC_CONVEX_URL` and `NEXT_PUBLIC_CONVEX_SITE_URL` for
> `content-ant-382` back into `.env.local`** — i.e. the documented "never select the load-test
> deployment" command selects it anyway, for everyone sharing the working copy. It happened here
> and `.env.local` was restored to `dev:tidy-peacock-243` immediately. `npx convex env set/list`
> and `npx convex run` with the same override do **not** rewrite the file; only the push does.
> `docs/verification/phase2.md` §0 should carry this warning: after any push to the load-test
> deployment, check `grep CONVEX_DEPLOYMENT .env.local` and restore it.

---

## 1. Part A — load test

### 1.1 Fixture and the two deviations from the brief's wording

* **Deployment** `dev:content-ant-382`, seeded by `scripts/loadtest-seed.ts` (50 leagues × 12
  teams × 17 weeks). Env at the time of the run: `SEED_SECRET`, `SITE_URL`,
  `COMMISSIONER_MODEL_ID=mock/scripted`, `INGEST_DISABLED=1`, `JWT_PRIVATE_KEY`, `JWKS`, and
  **no** `RUN_DISPATCH` (Phase 2 sets it to `skip`; it must be removed for the load test and
  restored afterwards, otherwise `windows.dispatch` creates the run documents and never enqueues
  them).

* **Deviation 1 — the window is `lineup_sun_late`, not `lineup_sun_early`.**
  `scripts/loadtest-seed.ts` pre-seeds twelve *finished* runs into every league's `waiver`,
  `lineup_sun_early` and `trade_1` window of **every** week (`RUN_WINDOW_INDICES = [4, 1, 5]`), and
  `windows.dispatch` skips a team that already has a run in the window — so opening
  `lineup_sun_early` creates **zero** runs. `lineup_sun_late` is the same `type: "lineup"` window
  over the same twelve teams with no pre-seeded runs, so the load is identical. (The first attempt
  used `lineup_thu`, also clean; its windows were closed again with `loadtest-run.ts close`.)

* **Deviation 2 — every current config version was repointed at `mock/scripted`.**
  The seed spreads teams over `mock/scripted`, `anthropic/claude-sonnet-4.5` and
  `openai/gpt-5-mini`; the load-test deployment has no `AI_GATEWAY_API_KEY`, so 400 of the 600 runs
  would have failed in `resolveModel` and the test would have measured the failure path.
  `loadtest-run.ts patch-models` rewrites all 600 `config_versions.modelId` through the
  `SEED_SECRET`-guarded `seed.patchBatch`. (`docs/CONVEX_CONVENTIONS.md` says config versions are
  never patched after insert; that rule is about the product's write paths, and this is the seed
  fixing its own fixture on a scratch deployment. It must be re-run after any re-seed.)

* The 50 `windows:openNow` calls go out as `npx convex run` child processes in batches of ten
  (`openNow` is an `internalMutation`, unreachable from `ConvexHttpClient`), so "the same moment"
  is a **6.1 s spread**, which is reported. Every window is first moved to `[now, now + 2 h]` with
  `windows:rescheduleNow` so that `submissionDeadlineAt` (the template's 20-minute lead → `now +
  100 min`) is a real future deadline rather than the seed's months-old one.

### 1.2 Numbers (`.cache/loadtest-run.json`, 2026-09-08)

| Measure | Value |
|---|---|
| Leagues × teams | 50 × 12 = **600 runs**, 600 observed |
| Window | `lineup_sun_late#1`, week 1 |
| Open-call spread | 6.1 s |
| First run finished | t0 + 31.7 s |
| **24th run finished** | t0 + **35.0 s** |
| **100th run finished** | t0 + **48.8 s** |
| **300th run finished** | t0 + **82.3 s** |
| **600th run finished** | t0 + **131.1 s** |
| Wall clock (t0 → all terminal observed) | **137.8 s** |
| Throughput | **261 runs/min**, 15.4 recorded steps/s |
| Status mix | `succeeded` 600 — no `partial`, `fallback`, `failed`, `timed_out` |
| Outcome mix | `lineup_set` 600 |
| Model | `mock/scripted` 600 |
| Steps per run (`runs.stepCount`) | max **4**; 474×4, 26×3, 69×2, 17×1, 14×0 (see §4.1) |
| Run duration | min 0.44 s, p50 2.59 s, p95 3.99 s, max 4.77 s |
| Fallbacks applied | 0 |
| Cost | $0.00 (mock model priced at zero) |
| **Every run before `submissionDeadlineAt`** | **yes — 0 misses**, last finish 131 s into a 100-minute window (a 45× margin) |
| After `closeNow` | 50/50 windows `closed`, `terminalRunCount == runCount` for all 50 |
| Runs the scheduler dispatched on its own during the test | **0** (`runs` went 31 812 → 33 012, exactly the 600 of the aborted `lineup_thu` attempt plus these 600) |

Progress curve (terminal runs per 10.8 s poll): 0, 47, 118, 177, 238, 307, 378, 438, 504, 571, 600.
Between the 24th and the 600th completion the rate is flat at **≈ 6.0 runs/s**.

### 1.3 Is `maxParallelism: 24` right?

Yes. Keep it.

* Little's law on the steady-state segment: 6.0 runs/s × ≈ 4 s of job wall time ≈ **24 jobs in
  flight** — the pool ran exactly at its cap for the whole test, so the number is the binding
  constraint and it is doing its job. (Measured *run* duration is 2.6 s at p50; the extra ~1.4 s is
  enqueue-to-start plus the snapshot load, which is why 6 runs/s and not 9.)
* The deadline is not close: 600 runs finished in **2 min 11 s** against a **100-minute**
  submission deadline. At the same 4 s per job, parallelism 24 clears **≈ 36 000 runs** inside one
  window; even at a real provider's 60 s per run it clears **≈ 2 400 runs** — 200 leagues — which
  is well past anything Phase 6 plans for.
* Raising it would buy nothing today and costs headroom: the documented guidance is to keep the sum
  of `maxParallelism` under 100 on Pro, and this is the only pool. The first thing that would break
  under a higher number is not the pool but the ledger's per-league-week rollup rows, which every
  concurrent run of a league writes (`bumpLeagueWeek` / `bumpModelWeek`, one document per
  league-week) — more parallelism means more OCC pressure on exactly those rows.
* **Batching teams per job is not needed** and would make the resume contract worse (one Workpool
  job currently maps 1:1 to one `runs` document and one `lastPersistedStep`).

Revisit when a single deployment exceeds ~200 in-season leagues, or when the per-run wall clock
(`league_rules.runWallclockSeconds`, default 300 s) is being hit — that, not the pool, is what puts
runs past the deadline.

### 1.4 Safety autopilot

`lineups` grew by **605** rows: 600 agent commits plus **5 autopilot repairs**. So for 595 of 600
`succeeded` runs the autopilot changed nothing, which is the expected outcome; **5 succeeded runs
still left a starting slot the autopilot had to fill.** That is consistent with the golden data
(some golden lineups also carry empty `TE`/`K` slots when the drafted roster cannot fill them), so
it reads as a thin-roster artefact of the generated fixture rather than a validation gap — but it
does mean "a succeeded lineup run needs no fallback" is not an invariant you can assert.

### 1.5 First attempt, and a coordination hazard

The first 50-league run (14:23, on `lineup_thu`) completed with the same shape — 600/600
`succeeded`, 162 s wall, 0 deadline misses — but **another engineer's `loadtest-seed.ts --reset`
began wiping the deployment ~30 s after it finished**, deleting `run_steps`, `run_actions`,
`usage_events`, `windows` and `snapshots` before the trace-level follow-up could be read. The
numbers in §1.2 are from a clean re-run after the re-seed finished. Two things follow:

* The load-test deployment is shared. `seed.clearTable` / `seed.reset` there destroy an in-flight
  measurement, and `clearTable` itself fails with *"Too many bytes read in a single function
  execution (limit 16777216)"* on the heavy tables (observed twice in the deployment log at
  14:27:40 and 14:28:58), so a reset is also slow and partial. Announce a reset, or take the
  deployment.
* The `RUN_DISPATCH=skip` variable is the other shared-state trap: it was re-set on the deployment
  between the two attempts, and a run started under it creates 600 `pending` runs that are never
  enqueued. `loadtest-run.ts close` exists to clean that up.

---

## 2. Part B — the simulated week

### 2.1 Why a second league

The brief's first option is `seed.reset` + `npm run seed:convex` with a flag that skips the
run/social/waiver tables. `scripts/seed-convex.ts` has no such flag, and `seed.reset` wipes every
app table on the deployment several packages are working against. So `scripts/e2e-week.ts` takes
the brief's fallback: it re-imports the golden league's **pre-run** tables under the slug
`e2e-league`, through the same `SEED_SECRET`-guarded `seed.importBatch`, with every `legacyId`
prefixed `e2e-league:` so a re-run recognises its own rows.

Imported (1 league, 1 rules row, 1 member, 12 teams, 17 weeks, 84 matchups, 12 agent configs, 12
config versions pinned to `mock/scripted`, 180 roster slots, 180 draft picks, the 180 `draft`
transactions, the 12 week-1 `draft_default` lineups, all 19 week-1 windows reset to `scheduled`
with no snapshot). Deliberately **not** imported: runs, steps, actions, usage events, waiver
claims, trades, threads, messages, forum posts, the `add`/`drop` transactions, snapshots — the
system produces those. `players`, `player_projections`, `player_projection_latest`, `nfl_games`,
`model_prices` and `skills` are league-independent and reused from the existing seed by `legacyId`.

Then the same three windows the old `scripts/smoke-e2e.ts` drove, in the same order, each
`windows:openNow` → poll until every run is terminal → `windows:closeNow` (+15 s for the scheduled
waiver processing / trade expiry / metrics), followed by `commissioner_agent:runWeekly` for week 1.

```
[ 1.2s] opened lineup_sun_early#1  -> 12 runs, 12 terminal in ~10 s -> closed {autopilots:12}
[28.4s] opened waiver#1            -> 12 runs, 12 terminal in ~10 s -> closed {autopilots:0}
[55.8s] opened trade_a#1           -> 12 runs, 12 terminal in ~15 s -> closed {autopilots:0}
[87.3s] commissioner_agent:runWeekly -> weekly_recap (3 posts) + flagged_trades_digest (1 post)
```

`runs.total` = **38**, exactly the golden count (36 team + 2 commissioner).

### 2.2 The diff

`scripts/golden-diff.ts` compares **113 behavioural invariants**. Identity crosses the two systems
only through sleeper ids (`players.legacyId` → golden uuid → `sleeper_id`) and team names; no id or
timestamp is compared. Result: **77 match, 20 expected differences, 16 unexplained** (exit 1).

#### Matching (the substance of the week)

| Invariant | Golden | New |
|---|---|---|
| `runs.total` | 38 | 38 |
| `lineup_sun_early#1` runs / status / outcome / steps | 12 / succeeded / `lineup_set` / 4 | identical |
| `waiver#1` runs / status / outcome | 12 / succeeded / `2_claims_submitted` | identical |
| `trade_a#1` runs / status | 12 / succeeded | identical |
| commissioner runs (`weekly_recap:3_posts`, `flagged_trades_digest:1_posts`) | 1 + 1, 1 step each | identical |
| **final week-1 lineup per team, by sleeper id and slot** | 12 teams × 9 starters | **all 12 identical** |
| lineup `source` | `agent` ×12 | `agent` ×12 |
| `set_lineup` / `set_rationale` actions | 12 / 12 | 12 / 12 |
| `submit_waiver_claims` / `set_rationale` (waiver) | 12 / 12 | 12 / 12 |
| `propose_trade` / `send_message` / `set_rationale` (trade) | 12 / 12 / 12 | 12 / 12 / 12 |
| waiver claims / won / lost | 24 / 2 / 22 | 24 / 2 / 22 |
| threads | 6 | 6 |
| forum posts, all flair `announcement` | 4 | 4 |
| transactions by type | draft 180, add 2, drop 2 | draft 180, add 2, drop 2 |

That the twelve agent lineups come out **player-for-player identical** to the ones the Postgres
system produced — from a snapshot rebuilt live, through a different executor, on a different
database — is the strongest single result in this document.

#### Expected differences (printed with their reason, do not fail the run)

| Invariant | Golden | New | Why |
|---|---|---|---|
| `actions.window.commissioner_*` | none | 4 `post_to_forum` | the old commissioner-agent service wrote **no** `run_actions` rows; `convex/commissioner_agent.ts` records each post, so the trace shows what the recap published. Additive. |
| `trades.count` | 11 | 12 | golden lost one `propose_trade` to a **Postgres race** — two runs inserted the same canonical `threads` pair and one hit the unique index (the raw insert error is in `run_actions.validation_result`). Convex does the thread upsert inside the proposal transaction, so all twelve commit. A fix, not a regression. |
| `trades.status.proposed` / `rejected` | 11 / — | 10 / 2 | two recipients found the proposal in `get_inbox` and answered it inside the same window. Both systems run the twelve trade runs concurrently, so this is scheduling-dependent either way. |
| `actions.window.trade_a#1.committed` / `rejected` | 35 / 1 | 38 / 0 | the two `respond_to_trade` calls, plus the proposal golden lost to the race. |
| `runs.window.trade_a#1.outcome.*` / `.steps.*` | 11×`…proposed+…sent`, 1×`…sent`; 12×7 steps | 10 + 2×`…proposed+…answered+…sent`; 10×7 + 2×8 | same cause. |
| `messages.count` | 23 | 26 | same cause (12 `send_message` + 12 proposal messages + 2 responses). |
| `waivers.wonBy.<sleeperId>` | 10219, 7049 → Stop Sequence | 12474, 2505 → Gradient Ascent | **all twelve teams bid $10 at priority 1 on the same player**, so the winner is an arbitrary tie-break in both systems; which free agent is top-ranked comes from the snapshot's free-agent list, rebuilt live here. Counts (24/2/22) match. |
| `trades.status.expired` | — | — | *predicted but did not occur.* `windows.close` expires proposals only on the **last** round of a trade label, and only `trade_a#1` of three rounds was driven — in **both** systems, so both leave the proposals `proposed`. |
| `waivers.count` | 24 | 24 | *predicted but did not occur.* `waivers.submit` replaces a team's pending claims rather than appending, but the mock calls it once per run, so 24 = 24. |

#### Unexplained differences — 16 rows, three defects (§4)

| Invariant | Golden | New |
|---|---|---|
| `usage.events` | 194 | **154** |
| `ledger.rollupsMatchEvents` (`ledger.verify`) | true | **false** |
| `lineup.<team>.viewDuplicateStarters` ×12 | 0 | **2** |
| `runs.window.waiver#1.steps.5` / `.steps.3` | 12 / — | 11 / 1 |

---

## 3. Deviations from the brief

1. Load test drives `lineup_sun_late#1`, not `lineup_sun_early#1` — §1.1.
2. All 600 load-test config versions were repointed at `mock/scripted` — §1.1.
3. The 50 windows are opened by 50 CLI processes over 6.1 s, not literally simultaneously — §1.1.
4. Part B uses a second league (`e2e-league`) rather than `seed.reset` + a re-seed — §2.1. This is
   the brief's own fallback; it also leaves the shared dev deployment's golden data intact.
5. `windows:rescheduleNow` moves each window's clock before it is opened, so
   `submissionDeadlineAt` is in the future; without it the seeded deadline is months in the past
   and the check is vacuous.

---

## 4. Defects found

None of these were fixed — no `convex/*.ts` file was touched.

### 4.1 The runtime records fewer steps than the runs claim (ledger under-recording)

**Severity: high — this is the billing ledger.**

Over the e2e week the 38 runs report `sum(runs.stepCount) = 194` (exactly the golden figure) but
the deployment holds **154 `usage_events` and 154 `run_steps`** — **21 % of the model calls are not
in the ledger.** The golden Postgres system had exactly one usage event per step (194/194).

Per-run evidence (`npx convex run runtime/dev:runReport`):

```
lineup run  pd71fzw26c3aqex0pbprf4e6ns8e0crk
  stepCount 4  lastPersistedStep 3  run_steps rows 3  usage_events 3
  step indices [1, 2, 3]              <- index 0 is missing
  actions      set_lineup@0, set_rationale@2

trade run   pd7fyzqpjtqp6z94ph0kf61gzx8e1r59
  stepCount 7  lastPersistedStep 6  run_steps rows 4  usage_events 4
  step indices [1, 3, 5, 6]           <- 0, 2 and 4 are missing
  actions      propose_trade@2, send_message@4, set_rationale@4

load-test run q573wvdf4p69rcjpytapa21kb18e1te1   (clean data, uncontended)
  stepCount 1  lastPersistedStep 0  run_steps rows 1  usage_events 1
  step indices [0]  (tool: get_my_team)
  actions      set_lineup@1, set_rationale@1   <- committed in steps that were never recorded
```

The last one is the clearest: the run committed both of its write tools in model steps that left no
`run_steps` row, no `usage_events` row and no cost. Under load this gets worse — in the 600-run
test **126 of 600 runs (21 %) report `stepCount` < 4**, 14 of them `stepCount: 0`, while all 600
committed exactly 2 actions and finished `lineup_set`.

Where it comes from: `convex/runtime/execute.ts#makeOnStepEnd` computes
`stepIndex = step.stepNumber + offset()` and treats the AI SDK's `onStepEnd` as "called exactly
once per model step, with a 0-based contiguous `stepNumber`". On `ai@^7.0.93` neither half holds —
index 0 is never produced and the sequence has gaps — so `persistStep` is called for only some
steps while `runs.stepCount` (`Math.max(stepCount, stepIndex + 1)`) keeps counting from the largest
index seen and therefore *over*-reports. `runs.stepCount` and `runs.lastPersistedStep` are
consistent with each other and inconsistent with the rows.

Consequences beyond the missing rows: `runs.totalCostUsd` and the three rollups are short by the
same steps; the resume contract (`lastPersistedStep` → `resumeMessages`) would replay a message
history with holes in it; and the trace viewer shows a run "with 7 steps" and four of them.

Suggested direction (for the executor's owner): derive the index from the number of steps this run
has already persisted rather than from `step.stepNumber` — e.g. keep a local counter seeded at
`persistedCount` and increment it in `onStepEnd` — and assert in a test that
`count(run_steps) === runs.stepCount` for a completed run. `convex/runtime/execute.test.ts` will
not catch this while it stubs the model, because the mock's `stepNumber` sequence is the thing
under test.

### 4.2 Rollup `runCount` is keyed on `stepIndex === 0`, and no run has a step 0

**Severity: medium — wrong numbers on every cost dashboard.**

`convex/ledger.ts:867` folds the run counter with

```ts
runCount: args.stepIndex === 0 ? 1 : 0,
```

so `team_week_rollups.runCount`, `model_week_rollups.runCount` and `league_week_rollups.runCount`
only count a run whose **first recorded step is index 0**. Because of §4.1 that is usually not the
case, and `ledger.verify` on the e2e week reports:

```
league.runCount               events 37, rollup 20
model[mock/scripted].runCount events 37, rollup 20
Greedy Decoders.runCount      events  3, rollup  0
Context Window Closers        events  3, rollup  0
Regression to the Mean        events  3, rollup  1     (+5 more teams wrong)
```

Note this is broken **independently** of §4.1: the migration plan's own resume design has a
retried run start at `lastPersistedStep + 1`, so a resumed run would never be counted either. The
condition should be "this run has no earlier `usage_events` row" (`by_runId_stepIndex`, take 1),
not "this is step 0". Token and USD figures reconcile correctly — only `runCount` is wrong.

### 4.3 `views.team` renders a repeated lineup slot with the same player twice

**Severity: medium — visible on every team page, no data loss.**

In `convex/views.ts#team` the slot grid is built as

```ts
const slotLabels = (currentLineup?.slots ?? []).map((s) => s.slot);
const lineup = slotLabels.map((slotLabel) => {
  const slotRow = (currentLineup?.slots ?? []).find((s) => s.slot === slotLabel);
  ...
});
```

`find` returns the **first** row with that label, so for a roster with two `RB` and two `WR` slots
(the default here) both `RB` cells resolve to RB1 and both `WR` cells to WR1. RB2 and WR2 are then
missing from `assigned` and get appended as `BENCH` rows. Every one of the twelve e2e teams shows
`viewDuplicateStarters = 2`.

The stored data is correct — the committed `set_lineup` payload has nine distinct players, and the
diff matches golden exactly once it reads the payload instead of the view — so this is purely the
read path. Fix: iterate `currentLineup.slots` positionally (`map((slotRow, i) => …)`) instead of
looking the label up.

The old Postgres team page rendered the slots positionally, so this is a **regression introduced by
the migration** and it is not covered by `convex/parity.test.ts` (the golden league's lineups
happen not to be exercised through this code path in a way that surfaces it).

### 4.4 Minor / unexplained

* **One waiver run took 3 model steps instead of 5** (`runs.window.waiver#1.steps.3` = 1 vs golden
  12×5). It committed both actions and produced `2_claims_submitted` like the other eleven, so the
  outcome is right. Given §4.1 makes `runs.stepCount` unreliable, this is most likely the same
  defect rather than a behavioural difference; it is left as an unexplained mismatch rather than
  waved through.
* **5 of 600 succeeded load-test runs still needed the safety autopilot** (§1.4).
* `seed.clearTable` exceeds the 16 MiB read limit on the heavy load-test tables (already noted in
  the Phase 2 report; observed again here). It makes `seed.reset` unusable on a full load-test
  deployment.

---

## 5. What this does and does not certify

Certified by these two checks:

* The scheduler path `windows.openNow → open → snapshot.build → dispatch → Workpool → executeRun →
  onComplete → closeNow` works at 50 leagues × 12 teams with no failed, partial, timed-out or
  fallback run, and `windows.runCount == windows.terminalRunCount` afterwards on all 50.
* `maxParallelism: 24` clears 600 runs in 2 min 11 s against a 100-minute deadline; no change
  needed, and no need to batch teams per job.
* Agent behaviour is faithful to the old system: identical lineups per team by sleeper id,
  identical action counts per window, identical waiver/thread/forum/transaction counts, identical
  run counts and outcomes per window. The differences that remain are one Postgres concurrency bug
  the migration removed, one scheduling-dependent trade interleaving, and one tie-break.

**Not** certified:

* The ledger. `usage_events` / `run_steps` under-record by ~21 % (§4.1) and the rollups'
  `runCount` is wrong (§4.2). `ledger.verify` returns `ok: false` for the e2e week. Phase 5 should
  not be signed off until `count(run_steps) === runs.stepCount` holds for a completed run and
  `ledger.verify` is green.
* Anything about real provider models: every run here was `mock/scripted`. The per-run wall clock,
  the budget stop and the fallback-model path were not exercised by this load test (0 fallbacks,
  $0 cost).
