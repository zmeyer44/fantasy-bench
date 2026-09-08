# Phase 2 verification — parity tests and the limits check

Brief §11. Two independent checks on the Convex read layer:

1. **Parity** (`convex/parity.test.ts`, `convex-test`) — every read procedure of
   `docs/migration-plan.md` §2.1 that became a Convex query is called against the golden
   Postgres week-1 dump and compared, key by key, with the shape the old tRPC procedure
   returned.
2. **Limits** (`scripts/loadtest-seed.ts` + `scripts/limits-check.ts`, a real deployment) —
   every public query is called against a 50-league, 17-week deployment and checked for
   read/time-limit errors.

Run them with:

```bash
npm run test:convex                      # includes parity.test.ts and limits.test.ts

# The load-test deployment runs the real scheduler; make it inert first (§2.3).
CONVEX_DEPLOYMENT=dev:content-ant-382 npx convex env set RUN_DISPATCH skip
CONVEX_DEPLOYMENT=dev:content-ant-382 npx convex env set INGEST_DISABLED 1
CONVEX_DEPLOYMENT=dev:content-ant-382 npx convex dev --once        # push current functions

npx tsx --env-file=.env.loadtest scripts/loadtest-seed.ts --leagues=50 --reset
npx tsx --env-file=.env.loadtest scripts/limits-check.ts --leagues=5 --seed=7
```

Timings on this run: seed 12m40s for 484 000 documents, limits check ~2 min for 311 calls.

---

## 0. Deployments

| Purpose | Deployment | URL |
|---|---|---|
| Shared dev (everyone's pushes; **selected** in `.env.local`) | `dev:tidy-peacock-243` | `https://tidy-peacock-243.convex.cloud` |
| **Load test** (this document; Phase 5's load test reuses it) | `dev:content-ant-382` — `zmmeyer44-gmail-com:fantasy-bench:dev/loadtest` | `https://content-ant-382.convex.cloud` |

The load-test deployment is **never selected**. It was created with
`npx convex deployment create zmmeyer44-gmail-com:fantasy-bench:dev/loadtest --type dev`
(no `--select`) and is always addressed explicitly:

```bash
CONVEX_DEPLOYMENT=dev:content-ant-382 npx convex dev --once        # push functions
CONVEX_DEPLOYMENT=dev:content-ant-382 npx convex env list          # verify before seeding
npx tsx --env-file=.env.loadtest scripts/loadtest-seed.ts          # seed / limits scripts
```

`.env.loadtest` carries it. Every `.env*` is git-ignored, so recreate the file from this:

```ini
CONVEX_DEPLOYMENT=dev:content-ant-382
NEXT_PUBLIC_CONVEX_URL=https://content-ant-382.convex.cloud
NEXT_PUBLIC_CONVEX_SITE_URL=https://content-ant-382.convex.site
SEED_SECRET=dev-seed-secret
```

Do not copy it into `.env.local` and do not `npx convex deployment select` it — that redirects
everyone's pushes. Deployment env vars set on the deployment itself: `SEED_SECRET`, `SITE_URL`,
`COMMISSIONER_MODEL_ID`, `JWT_PRIVATE_KEY`, `JWKS` (the last two copied from the shared dev
deployment so the Convex Auth password flow works there).

Both scripts refuse outright to run against `tidy-peacock-243`, and every write goes through
the `SEED_SECRET`-guarded `seed.importBatch`. The load-test user is
`loadtest@fantasybench.dev` / `password1234`, commissioner of all 50 leagues and owner of each
league's team 0.

---

## 1. Parity tests

### 1.1 How the check works

`convex/parity.test.ts` loads the **whole** golden dump — `tests/golden/postgres-week1/*.json`,
3 230 players, 12 teams, 17 weeks, 20 windows, 4 snapshots, 38 runs, 194 steps, 194 usage
events, 11 trades, 6 threads, 23 messages, 4 forum posts — into `convex-test` in one `t.run`,
applying the same golden → Convex mapping `scripts/seed-convex.ts` applies (that script is a
program, not a module, so the mappers are reproduced in the test; the two must be kept in
step). It then calls every query twice, once as the demo user
(`t.withIdentity({ subject: "<userId>|<sessionId>" })`, with a real `users` row and an
`authSessions` row) and once anonymously, and asserts:

* **(a) shape.** `assertSameKeys(expected, actual, path)` walks the expected skeleton,
  including the first element of every array, and requires the same key set at every level.
  The skeletons are pinned to the old types at compile time — each is written
  `as const satisfies Shape<OldReturnType>`, where `Shape<T>` is a recursive mapped type, so a
  skeleton that drifts from the old service type fails `npm run typecheck`. Epoch-ms numbers
  are accepted where the old shape had a `Date` (the `"date"` sentinel checks that the value
  really is a number).
* **(b) values.** Per query, a handful of assertions read off the golden JSON: row counts,
  team names, sort orders, a known lineup slot count, the known trade status, the known post
  score, the known model id.

`lib/trpc/**` is deleted by package H during Phase 3, so `inferRouterOutputs<AppRouter>` is no
longer available. The old return types are instead composed in the test from **type-only**
imports of `lib/services/**` and `lib/db/types` (the `Old` type at the top of the file names
the procedure → service mapping); the six procedures whose router built an object literal
inline are spelled out from the router source at commit `98eef3a`.

Convex document envelopes are normalised before comparison: `_id` is read as the old `id`, and
`_creationTime` and the migration-only `legacyId` are dropped. Everything else is compared
as-is, and a key that is absent on the Convex document (because the value is unset) is
reported as missing rather than silently accepted.

### 1.2 Results — 40 queries, 48 tests, all green

| Old tRPC procedure | Convex query | Shape | Values | Deviations |
|---|---|---|---|---|
| `league.get` | `leagues.get` | pass | pass | A ×2, **C1** |
| `league.listMine` | `leagues.listMine` | pass | pass | A ×1 |
| `config.get` | `configs.get` | pass | pass | A ×5, B ×7 |
| `config.versions` | `configs.versions` | pass | pass | A ×4, B ×4 |
| `config.version` | `configs.version` | pass | pass | A ×1, B ×3 |
| `config.diff` | `configs.diff` | pass | pass | — |
| `config.lockStatus` | `configs.lockStatus` | pass | pass | — |
| `config.estimate` | `configs.estimate` | pass | pass | — |
| `skills.list` | `skills.list` | pass | pass | A ×1 |
| `skills.get` | `skills.get` | pass | pass | A ×1 |
| `cost.team` | `ledger.teamDashboard` | pass | pass | — |
| `cost.league` | `ledger.leagueDashboard` | pass | pass | — |
| `cost.benchmark` | `ledger.benchmark` | pass | pass | — |
| `views.home` | `views.home` | pass | pass | B ×3 |
| `views.standings` | `views.standings` | pass | pass | — |
| `views.teams` | `views.teams` | pass | pass | — |
| `views.team` | `views.team` | pass | pass | — |
| `views.matchups` | `views.matchups` | pass | pass | — |
| `views.matchup` | `views.matchup` | pass | pass | — |
| `views.draftBoard` | `draft.board` | pass | pass | — |
| `views.waivers` | `waivers.results` | pass | pass | — |
| `views.windowsForWeek` | `windows.forWeek` | pass | pass | B ×1 |
| `views.windowSchedule` | `windows.schedule` | pass | pass | B ×3 |
| `traces.list` | `runs.list` | pass | pass | **C2** |
| `traces.search` | `runs.search` | pass | pass | **C2** |
| `traces.get` | `runs.get` + `runs.steps` | pass | pass | **C2**, **C3**, B ×2 |
| `traces.modelOptions` | `runs.modelOptions` | pass | pass | — |
| `traces.export` | `runs.export` | pass | pass | — |
| `traces.exportTeam` | `runs.exportTeamPage` | pass | pass | **C2** |
| — | `runs.stepPayload` | n/a | n/a | no golden rows (see below) |
| `commissioner.settings` | `commissioner.settings` | pass | pass | A ×1, B ×1, **C4** |
| `commissioner.inviteLink` | `commissioner.inviteLink` | pass | pass | **C4** |
| `commissioner.changeLog` | `commissioner.changeLog` | pass | pass | **C2** |
| `trades.list` | `trades.list` | pass | pass | — |
| `trades.get` | `trades.get` | pass | pass | B ×1 |
| `messaging.listThreads` | `messaging.listThreads` | pass | pass | — |
| `messaging.getThread` | `messaging.getThread` | pass | pass | **C2**, **C5** |
| `forum.list` | `forum.list` | pass | pass | **C2**, A ×1, **C6** |
| `forum.get` | `forum.get` | pass | pass | — |
| `forum.karma` | `forum.karma` | pass | pass | **C7** |

Auth parity was checked at the same time: a public league reads signed out
(`leagues.get`, `skills.*`), `leagues.listMine` rejects an anonymous caller with
`UNAUTHORIZED` exactly as the old `protectedProcedure` did, and `commissioner.settings`
rejects a non-commissioner.

### 1.3 Deviations

Each one is encoded explicitly in the test — the assertion is
`assertSameKeysExcept(expected, actual, path, [...])` with the deviation spelled out — so an
undeclared difference is a failure, and a deviation that disappears is also a failure.

**A — an optional field is absent instead of null.** Convex has no `undefined`; an unset
optional column is simply not on the document, whereas the Postgres row always carried the key
with a `null` (`docs/CONVEX_CONVENTIONS.md`: "an absent field is the null"). Affects
`leagues.joinCode`, `teams.ownerUserId`, `agent_configs.noteToAgent` / `pendingVersionId`,
`config_versions.createdByUserId`, `skills.forkedFromSkillId` and `forum_posts.comments` on the
list path. **Systematic, not per-query.** The UI reads these through `Doc<>` types where they
are `field?: T`, so nothing breaks, but a JSON consumer that expected `"joinCode": null` now
sees the key missing.

**B — additive Convex column.** `docs/migration-plan.md` §2.3 denormalises ids onto child
documents so every read can use an index and folds one-to-many join tables into their parent.
Observed: `agent_configs.leagueId`; `config_versions.leagueId` / `teamId` / `skillIds`
(replacing `config_version_skills`); `windows.terminalRunCount` (a counter the write paths
maintain — the old `WindowView` had only `runCount`, from a correlated subquery);
`runs.lastPersistedStep` (the Workpool resume marker, §4); `run_steps.gatewayCostUsd`;
`commissioner.settings.teams`; `trades.get.myVote`.

**C1 — `leagues.get` returns a superset. NOT previously documented.** The old `league.get`
returned `{ league, teams, membership }`; the Convex query adds `rules`, `role`,
`isCommissioner` and `viewerTeamId`. Additive and harmless (the pages used to re-fetch rules
and derive the viewer's role client-side), but it was not on the Phase 2 deviation list, so it
is recorded here.

**C2 — paginated lists carry no totals.** Documented. `traces.list` returned
`{ items, page, pageSize, total, pageCount, matchedPlayers }`; the Convex queries return the
`paginate()` envelope `{ page, isDone, continueCursor }`. A `COUNT(*)` over an unbounded index
range is exactly the read the limits work removes. Applies to `runs.list`, `runs.search`,
`runs.steps`, `runs.usageEvents`, `runs.exportTeamPage`, `commissioner.changeLog`,
`forum.list` and `messaging.getThread`. The test asserts the envelope has `page` / `isDone` /
`continueCursor` and does **not** have `total` / `pageCount`, and pages twice.

**C3 — `runs.get` carries usage totals only.** Documented. `traces.get` inlined every step,
action and usage event; `runs.get` returns the header (with `usage` as a totals object rather
than an array) and no `steps` key at all — steps come from `runs.steps`, usage events from
`runs.usageEvents`. Without this a 200-step run would push the 16 MiB / 32 000-document
transaction limits.

**C4 — `commissioner.settings.invite` is null until minted.** Documented. The old procedure
minted a join code as a *side effect of reading* (`ensureJoinCode` wrote to the league row). A
Convex query cannot write, so `invite` comes back `{ code: null, url: null }` until
`commissioner.rotateJoinCode` mints one. `commissioner.inviteLink` behaves the same way.

**C5 — `messaging.getThread.messages` is paginated.** Documented. The old `getThread` returned
the entire message history in one array.

**C6 — forum `hot` is bounded at 200.** Documented. `hot` is a time-decayed rank and therefore
not indexable, so `forum.list` ranks the newest `HOT_WINDOW = 200` posts and slices the page
out of that ranking; it is bounded, not paginated past 200. The old service had the same shape
of bound with a *smaller* constant (`max(limit * 4, 100)`), so this is a wider window.

**C7 — `forum.karma` renames `id` to `teamId`. NOT previously documented.** The old procedure
was an inline Drizzle projection `{ id, name, karma }` selecting `teams.id`; the Convex query
returns `{ teamId, name, karma }`. A one-word rename in a three-field row — trivial to
consume, but it is a wire-shape change that was not on the deviation list.

**`views.teams` ordering is NOT a deviation.** The Phase 2 reports flagged it as one. On the
golden dataset it is not: `views.teams` returns cards in `views.standings` order (wins desc,
pointsFor desc, `teamName` asc) with matching `rank` values, which is what the old `teamCards`
did. The test asserts the two orders are identical, so a future regression would be caught.

**`runs.stepPayload` has no parity case.** `run_step_payloads` only receives tool results over
64 KB (PRD 5.8) and every golden step is well under that, so the overflow table is empty. The
test asserts this explicitly rather than silently skipping. The query is exercised on the
load-test deployment instead, where `scripts/loadtest-seed.ts` writes one oversized tool result
per league and wires its `payloadRef` into the step, the way the runtime does (§2.2).

### 1.4 Bounds tests (`convex/limits.test.ts`)

`convex-test` is a mock and enforces no limits at all (`docs/CONVEX_NOTES.md` §9), so a
convex-test file cannot observe "Too many documents read". What it *can* do is prove the caps
that keep those reads small are actually applied, so this file builds **one deliberately
oversized league** — 14 teams, 22 weeks, 900 waiver claims in week 1, 700 forum posts, 900
comments on one post, 400 threads, 400 trades, 600 draft picks, 500 runs, one run with 300
steps — and asserts each read comes back capped at the constant its module declares:

| Query | Cap | Constant | Result on the oversized league |
|---|---|---|---|
| `waivers.results` | 200 claims/week | `waivers.MAX_CLAIMS_PER_WEEK` | exactly 200 of 900 |
| `draft.board` | 300 picks | `draft.MAX_PICKS` | exactly 300 of 600 |
| `forum.list` (`hot`) | 200-post ranking window | `forum.HOT_WINDOW` | 200 of 700, then `isDone` |
| `forum.get` | 500 comments | `forum.MAX_COMMENTS` | exactly 500 of 900 |
| `messaging.listThreads` | 100 threads, `limit` clamped | `messaging.MAX_THREADS` | 100 of 400; `limit: 5000` still 100 |
| `trades.list` | 100 trades, `limit` clamped | `trades.MAX_FEED` | 100 of 400; `limit: 5000` still 100 |
| `ledger.leagueDashboard` | 50 expensive runs | `ledger.EXPENSIVE_RUN_SCAN` + arg clamp | 50 with `limit: 5000` |
| `runs.get` | header only | — | no `steps` key on a 300-step run |
| `runs.export` | 64 steps inlined | `runs.MAX_STEPS_PER_RUN` | exactly 64 of 300 |
| `runs.steps` / `runs.list` / `runs.exportTeamPage` | paginated | — | exact page size, `isDone: false` |
| `views.home` / `views.standings` | team-sized | — | 14 rows, ≤5 posts, ≤5 trades |

All 12 pass. If somebody removes a `.take(...)` or turns a bounded range into a `.collect()`,
the result stops being capped and these fail — which is the regression the limits work exists
to prevent.

Three of these caps are **silent truncations** worth knowing about, and the tests pin them:

* `waivers.results` derives `pendingCount` and `weeksWithClaims` from the same capped
  200-per-week window it uses for `results`. A league where every team files more than
  `200 / teamCount` claims in a week under-reports both. A 14-team league at 15 claims each is
  210 — already over.
* `draft.board` caps at 300 picks. A 14-team league with a 20-slot roster drafts 280, which
  fits; 22 slots would not.
* `runs.export` inlines at most `MAX_STEPS_PER_RUN = 64` steps, justified by
  `league_rules.maxStepsCap` being ≤ 31 in every shipped config. A run that exceeded 64 steps
  would export incompletely with no marker in the file.

---

## 2. Limits check against a 50-league deployment

### 2.1 The dataset (`scripts/loadtest-seed.ts`)

50 leagues x 12 teams x a full 17-week season, generated deterministically
(`mulberry32` seeded by league index) from the golden league as a template — its rules, roster
layout, team names, player pool and snapshot payload. Everything is written through the same
`SEED_SECRET`-guarded `seed.importBatch` the golden seed uses, in batches of at most 400 rows.

Per league: 12 teams, 17 weeks, 306 windows (18/week: 4 lineup, 1 waiver, 6 trade, 5 forum,
2 commissioner), 102 matchups, 204 team results, 12 standings rows, 180 roster slots, 204
lineups, 180 draft picks, 12 configs + 12 versions, 4 snapshots (24 chunks, 4 digests), 612
runs x 4 steps = 2 448 steps, 2 448 usage events, 612 actions, 612 search docs, 1 oversized
tool-result payload, 204 waiver claims, 204 transactions, 68 threads, 272 messages, 68 trades
+ 136 trade events, 51 posts, 153 comments, 255 votes, and the three rollup tables.

The script prints progress, is **resumable by league index** (`--from=I`; a league is finished
when its `joinCode` starts with `LOADTEST-DONE-`, and finished leagues are skipped), and has a
`--reset` flag that clears every app table through `seed.clearTable` — the way back to a clean
deployment when a league dies half way, since only the `leagues` row carries the marker.

**One deliberate undershoot.** The brief asks for one snapshot per lineup window (4/week =>
68/league). The golden snapshot payload is 479 KB, so that is 32 MB of `snapshot_chunks` per
league and 1.6 GB overall — hours of upload. `SNAPSHOT_WINDOWS_PER_LEAGUE = 4` caps it at the
final week's four lineup windows. Nothing is lost for the limits question: every snapshot read
is scoped to one snapshot's chunks by `snapshot_chunks.by_snapshotId_kind_part`, so the
per-read size is identical whether a league holds 4 snapshots or 68. Raise the constant if a
later phase needs the history.

The global tables (`players`, `player_projections`, `player_projection_latest`, `nfl_games`)
are imported once and shared by all 50 leagues, exactly as production works, and `--reset`
leaves them alone so a re-seed does not re-upload 6.5 MB of player rows.

The season is placed so the **final** week is the current one (week 1 starts
`WEEKS - 1` weeks ago), which is what makes `weeks.currentWeekNo` return 17 and therefore what
makes `views.home`, `metrics.filmRoom` and the snapshot reads land on the week that has data.
Window `status` follows the clock — `closed` / `open` / `scheduled` — rather than being forced.

### 2.2 The check (`scripts/limits-check.ts`)

The function list is **not hard-coded**: the script shells out to `npx convex function-spec`
against `CONVEX_DEPLOYMENT` and takes every `Query` with `visibility: public`. A query added
later with no argument recipe is reported as a failure ("this query was NOT checked"), so it
cannot silently go unexercised.

It signs in through the real Convex Auth password flow and sets the token on the
`ConvexHttpClient`, so member-only and commissioner-only reads are exercised as the owner of
team 0 and commissioner of every league. For each of 5 randomly sampled leagues it resolves the
*largest* team (most runs), run (most steps), thread (most messages) and post (most comments)
it can see, plus a matchup, a trade, a snapshot, two config versions and the overflow payload
id, and calls every query with those. Paginated queries fetch a second page with the returned
cursor; `seed.*` queries page with their bare `cursor` argument.

Each call is timed **twice**: the first number carries the deployment's cold start (module load
after a push), the second is the warm number the 1 s threshold is judged on. Both are wall
clock at the client, so they include the round trip — they are an upper bound on server time.

Errors are matched against the limit signatures from `docs/CONVEX_NOTES.md` §4 ("Too many
documents read", "Too many bytes read", index-range exhaustion, execution timeouts) and
reported as `[LIMIT]`; anything else is `[ERROR]`. The script exits 1 if any call failed.

### 2.3 The deployment runs the real scheduler — turn it off before seeding

The first attempt at the final re-seed died with

```
OptimisticConcurrencyControlFailure: Documents read from or written to the "runs" table
changed while this mutation was being run and on every subsequent retry.
A call to "runs.js:persistStep" changed the document with ID "…"
```

`convex/crons.ts` is deployed to the load-test deployment like everything else, and it ticks
every 5–15 minutes. `season.tickAll` fans out over every league whose status is `in_season` —
all 50 of them — and that ends in `windows.open` → `windows.dispatch` → the Workpool running
`runtime/execute:executeRun` for real. Those runs write `runs`, `run_steps`, `usage_events` and
the three rollups underneath the bulk import, and Convex's OCC gives up after its retries.

The two documented kill switches make the deployment inert; set them **before** seeding:

```bash
CONVEX_DEPLOYMENT=dev:content-ant-382 npx convex env set RUN_DISPATCH skip   # windows.ts
CONVEX_DEPLOYMENT=dev:content-ant-382 npx convex env set INGEST_DISABLED 1   # ingest.ts
```

Both are already set on `dev:content-ant-382`. A Phase 5 load test that *wants* the runtime
should unset `RUN_DISPATCH` deliberately, after seeding, not before.

### 2.4 Results — 57 public queries, 311 calls, 0 failures

Deployment `dev:content-ant-382`, 50 leagues / 484 000 documents, sampling
`loadtest-036`, `loadtest-010`, `loadtest-015`, `loadtest-038`, `loadtest-016` (`--leagues=5
--seed=7`). `scripts/limits-check.ts` exited **0**.

* Every one of the 57 public queries was exercised — none skipped, none without a recipe.
* **No read or time limit was hit**: no "Too many documents read", no "Too many bytes read", no
  index-range exhaustion, no timeout, on either page of the paginated queries.
* **No query exceeded 1 s warm.** The slowest warm number is 298 ms (`runs.search`).
* Two queries exceed 1 s **cold** — `ledger.leagueDashboard` (1 447 ms) and `ledger.benchmark`
  (1 372 ms). See §2.5; they are the two that make ~300 sequential database round trips.

| Query | Calls | Max warm | Max cold | Result |
|---|---:|---:|---:|---|
| `runs.search` | 10 | 298 ms | 306 ms | pass |
| `weeks.currentWeekNo` | 5 | 284 ms | 116 ms | pass |
| `runs.exportTeamPage` | 5 | 254 ms | 293 ms | pass |
| `runs.list` | 20 | 247 ms | 187 ms | pass |
| `seed.tableCount` | 1 | 123 ms | 44 ms | pass |
| `forum.list` | 15 | 108 ms | 109 ms | pass |
| `skills.list` | 3 | 107 ms | 68 ms | pass |
| `ledger.benchmark` | 5 | 101 ms | 1372 ms | pass |
| `auth.isAuthenticated` | 1 | 95 ms | 42 ms | pass |
| `messaging.getThread` | 5 | 95 ms | 101 ms | pass |
| `configs.version` | 5 | 93 ms | 92 ms | pass |
| `transactions.list` | 5 | 91 ms | 92 ms | pass |
| `configs.get` | 5 | 88 ms | 134 ms | pass |
| `commissioner.settings` | 5 | 84 ms | 366 ms | pass |
| `commissioner.inviteLink` | 5 | 73 ms | 76 ms | pass |
| `views.home` | 5 | 73 ms | 355 ms | pass |
| `configs.lockStatus` | 5 | 69 ms | 100 ms | pass |
| `messaging.listThreads` | 10 | 69 ms | 746 ms | pass |
| `commissioner.changeLog` | 5 | 64 ms | 72 ms | pass |
| `configs.estimate` | 5 | 61 ms | 76 ms | pass |
| `draft.board` | 5 | 61 ms | 762 ms | pass |
| `windows.schedule` | 10 | 58 ms | 90 ms | pass |
| `runs.searchPlayers` | 5 | 57 ms | 104 ms | pass |
| `views.teams` | 5 | 56 ms | 50 ms | pass |
| `trades.list` | 15 | 55 ms | 162 ms | pass |
| `runs.modelOptions` | 5 | 54 ms | 163 ms | pass |
| `ledger.leagueDashboard` | 10 | 52 ms | 1447 ms | pass |
| `transactions.forTeam` | 5 | 52 ms | 97 ms | pass |
| `configs.diff` | 5 | 51 ms | 66 ms | pass |
| `windows.forWeek` | 5 | 51 ms | 68 ms | pass |
| `configs.versions` | 5 | 50 ms | 59 ms | pass |
| `seed.lookupLegacy` | 1 | 50 ms | 127 ms | pass |
| `forum.karma` | 5 | 48 ms | 77 ms | pass |
| `metrics.filmRoom` | 10 | 48 ms | 476 ms | pass |
| `runs.get` | 5 | 48 ms | 103 ms | pass |
| `views.matchups` | 5 | 48 ms | 51 ms | pass |
| `views.team` | 5 | 48 ms | 334 ms | pass |
| `runs.stepPayload` | 5 | 47 ms | 80 ms | pass |
| `runs.steps` | 5 | 47 ms | 96 ms | pass |
| `waivers.results` | 5 | 47 ms | 265 ms | pass |
| `weeks.list` | 5 | 47 ms | 69 ms | pass |
| `leagues.listMine` | 1 | 46 ms | 189 ms | pass |
| `runs.usageEvents` | 5 | 46 ms | 73 ms | pass |
| `ledger.teamDashboard` | 5 | 45 ms | 350 ms | pass |
| `views.matchup` | 5 | 45 ms | 374 ms | pass |
| `leagues.bySlug` | 5 | 44 ms | 40 ms | pass |
| `snapshot.meta` | 5 | 44 ms | 79 ms | pass |
| `trades.get` | 5 | 44 ms | 138 ms | pass |
| `users.byEmailPublic` | 1 | 44 ms | 46 ms | pass |
| `views.standings` | 5 | 44 ms | 172 ms | pass |
| `forum.get` | 5 | 43 ms | 105 ms | pass |
| `ledger.modelPrices` | 1 | 43 ms | 79 ms | pass |
| `runs.export` | 5 | 43 ms | 93 ms | pass |
| `skills.get` | 1 | 43 ms | 59 ms | pass |
| `leagues.get` | 5 | 42 ms | 68 ms | pass |
| `users.me` | 1 | 42 ms | 187 ms | pass |
| `leagues.byJoinCode` | 5 | 41 ms | 69 ms | pass |

`runs.stepPayload` is reachable only through a step's `payloadRef`; the seed writes one
oversized tool result per league on that league's first run, and the check follows the ref from
`runs.steps`, exactly as the trace viewer does.

### 2.5 Findings

**No query hit a read or time limit.** Nothing in the run produced "Too many documents read",
"Too many bytes read", index-range exhaustion or a timeout, on any of the 5 sampled leagues,
for either page of the paginated queries.

**One mutation does — `seed.clearTable`.** Not a query, and not on any user path, but it is a
real limit breach found by this work and it blocks re-seeding:

```
Uncaught Error: Too many bytes read in a single function execution (limit: 16777216 bytes).
Consider using smaller limits in your queries, paginating your queries, or using indexed
queries with a selective index range expressions.
    at async handler (../convex/seed.ts:338:22)
```

`convex/seed.ts#clearTable` reads `ctx.db.query(table).take(DELETE_BATCH)` with
`DELETE_BATCH = 1000` before deleting. That is fine for small rows and fatal for
`snapshot_chunks`, whose documents are ~100 KB each: 1 000 of them is ~100 MB against a 16 MiB
limit. `runs` fails the same way once the runtime has written `promptSections` onto them, and
`internal.seed.reset` has the same exposure through `RESET_BATCH = 2000`. The fix is a
byte-aware batch — either a per-table `DELETE_BATCH`, or accumulate `row.bytes` and stop at a
few MB. Until then `snapshot_chunks` cannot be cleared once a deployment holds more than about
160 of them, which is any load-test deployment. `scripts/loadtest-seed.ts` clears that table
last, reports the failure per table and carries on; the orphans are unreachable (their `snapshots` rows
are gone) and cost only storage, because every chunk read is scoped to one `snapshotId` by
`snapshot_chunks.by_snapshotId_kind_part`. **Owner: package A (`convex/seed.ts`).**

**Nothing is unbounded.** Every `.collect()` in `convex/*.ts` carries a bound that holds by
construction — league teams (≤14), one team's roster (~20), one league week's windows (~18),
one snapshot's chunks — and every other read is a `.take(n)`, a `.first()`, a `.unique()` or a
`.paginate(...)`. The reads that grow fastest with real data, and their ceilings:

| Query | Worst-case documents | Worst-case index ranges | Why it is bounded |
|---|---|---|---|
| `waivers.results` | 23 x 200 = **4 600** claims + 2 gets per rendered claim | 24 | one range per week, `take(MAX_CLAIMS_PER_WEEK)` |
| `ledger.leagueDashboard` | ~540 | ~**335** | `MAX_WEEK + 1` ranges per team-season rollup + 23 model-week ranges + `take(200)` runs |
| `ledger.benchmark` | ~330 | ~**312** | `MAX_WEEK + 1` ranges per team |
| `draft.board` | 300 picks x (player + run) = **900** | 2 | `take(MAX_PICKS)` |
| `forum.list` (`hot`/`top`) | 200 posts + teams | 1 | `take(HOT_WINDOW)` |
| `forum.get` | 500 comments | 2 | `take(MAX_COMMENTS)` |
| `runs.export` | 1 run + `take(64)` steps + `take(200)` actions + `take(300)` payloads | 4 | per-run caps |

The tightest of these is 4 600 documents against a 32 000 limit and 335 index ranges against a
4 096 limit — an order of magnitude of headroom in both.

**Two queries are slow for a reason worth fixing.** `ledger.leagueDashboard` (1 447 ms) and
`ledger.benchmark` (1 372 ms) are the only queries whose *cold* wall clock passed a second.
Warm they are under 110 ms, so they are nowhere near failing — but they are the two
that do the most **sequential** database round trips inside one transaction, and that is what
the 1 s query-time limit actually measures. Both call `teamWeekRollups(ctx, teamId, season)`,
which loops `for (let week = 0; week <= MAX_WEEK; week++)` and issues one `.unique()` per week:
23 sequential reads per team, 12–14 teams, so **~300 round trips** where one range read would
do. `leagueWeekRollups` and the `model_week_rollups` loop in `leagueDashboard` have the same
shape.

The fix is mechanical and stays inside the same index: replace the per-week loop with a single
range read, e.g.

```ts
await ctx.db
  .query("team_week_rollups")
  .withIndex("by_teamId_season_weekNo", (q) => q.eq("teamId", teamId).eq("season", season))
  .take(MAX_WEEK + 1);
```

That turns ~300 index ranges into ~14 and should take both queries to the same ~40 ms the rest
of the read layer sits at. It is not a correctness problem and not a limit breach today; it is
the query that will break first when leagues get 18-week seasons plus playoff rounds, or when
`MAX_WEEK` grows. **Owner: package B (`convex/ledger.ts`).**

**A latent gap in the golden importer.** `scripts/seed-convex.ts` writes overflowed tool
results as `{ toolCallId, payloadRef: null, overflowed: true }` — the `payloadRef` is never
filled in, so a `run_step_payloads` row imported from Postgres would be unreachable from the
trace viewer (`convex/runs.ts` follows `payloadRef` to call `runs.stepPayload`). It is latent
today because no golden step exceeds the 64 KB inline limit, so the overflow table is empty;
`scripts/loadtest-seed.ts` does write a real `payloadRef`, which is how `runs.stepPayload` gets
exercised here. **Owner: package A (`scripts/seed-convex.ts`).**

---

## 3. Summary

| Check | Result |
|---|---|
| `npm run test:convex` | green, including `convex/parity.test.ts` (48 tests) and `convex/limits.test.ts` (12 tests) |
| `npx eslint` on the four owned files | clean |
| `npx tsc --noEmit` on the four owned files | clean (the `satisfies Shape<…>` skeletons are what makes this meaningful) |
| Parity: read procedures of §2.1 covered | 40 of 40 |
| Parity: undocumented mismatches | 2, both additive/cosmetic (C1, C7) |
| Limits: public queries in the deployment | 57 |
| Limits: queries exercised | 57 (311 calls across 5 sampled leagues) |
| Limits: failures | 0 |
| Limits: read/time-limit errors | 0 in queries; **1 in `seed.clearTable`** (see §2.5) |
| Limits: queries over 1 s warm | 0 (slowest 298 ms); 2 over 1 s cold |
| Load-test dataset | 50 leagues, 484 000 documents, 12m40s to seed |

### What a later phase should pick up

1. **`convex/ledger.ts` — replace the per-week `.unique()` loops with one range read.**
   `teamWeekRollups` / `leagueWeekRollups` / the `model_week_rollups` loop in
   `leagueDashboard` issue ~300 sequential index reads per call; one `.take(MAX_WEEK + 1)` on
   the same index does the same job. This is the only query pair whose cold wall clock passed a
   second. (Package B.)
2. **`convex/seed.ts` — make `clearTable` / `reset` byte-aware.** `DELETE_BATCH = 1000` and
   `RESET_BATCH = 2000` read the rows before deleting them, which blows the 16 MiB read limit
   on any table with large documents (`snapshot_chunks`, `runs` with `promptSections`). This is
   the one limit breach the work found. (Package A.)
3. **`scripts/seed-convex.ts` — fill in `payloadRef` for overflowed tool results.** Latent
   today because the golden dump has no oversized results. (Package A.)
4. **Three reads truncate silently.** `waivers.results` derives `pendingCount` and
   `weeksWithClaims` from the capped 200-claims-per-week window; `draft.board` stops at 300
   picks; `runs.export` inlines at most 64 steps. All three caps are fine for a 12-team league
   with the shipped `maxStepsCap`, but a 14-team league with a 22-slot roster, a busy waiver
   week, or a raised step cap would quietly under-report. Either raise the cap or surface a
   `truncated` flag. (Packages B and G.)
5. **The load-test deployment is left seeded** for the Phase 5 load test: `dev:content-ant-382`
   / `https://content-ant-382.convex.cloud`. Re-push functions to it with
   `CONVEX_DEPLOYMENT=dev:content-ant-382 npx convex dev --once` before reusing it, and re-seed
   with `--reset` if the schema has moved on. Two caveats from the `clearTable` bug above: the
   deployment carries ~1 500 orphaned `snapshot_chunks` and ~1 200 orphaned `runs` that
   `--reset` could not delete (unreachable — their parents are gone — and scoped out of every
   query by `leagueId`/`snapshotId`), and `RUN_DISPATCH=skip` / `INGEST_DISABLED=1` are set, so
   unset them deliberately if Phase 5 wants the runtime to execute.
6. **`convex/parity.test.ts` imports the old service types from `lib/services/**`.** Those
   modules are deleted in the cleanup phase; when that happens, either snapshot the types into
   the test or retire the file. Until then it is the only thing tying the Convex read layer to
   the shapes the old UI consumed.
