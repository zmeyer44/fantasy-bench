# Convex migration — Phase 1 plan

Status: **plan, awaiting approval before Phase 2.**
Companion files: `convex/schema.ts` (type-checks against convex 1.45.0), `docs/CONVEX_NOTES.md` (API reference verified against docs.convex.dev on 2026-09-08, every section cites its page).

## 1. What was verified, and where the brief and the docs disagree

Everything below comes from fetched documentation or the repo, not memory.

| Topic | Brief says | Docs / repo say | Decision |
|---|---|---|---|
| Action time limit | 10 minutes | Limits page: **30 min in the default runtime, 10 min under `"use node"`**. The actions page still says "10 minutes". | Design to 10 minutes (safe under both). |
| `executeRun` runtime | "Try the default runtime first" | Default runtime's supported-API list has **no `setTimeout`**. The executor's wall-clock abort and the AI SDK's retry backoff (`maxRetries: 3`) both use `setTimeout`. `ai` 7 / `@ai-sdk/gateway` 4 declare `engines: node >= 22`; their Node-only paths (`node:diagnostics_channel`, `Buffer`) are guarded. | Phase 5 tries the default runtime with a one-line probe action first. Expect `"use node"` for `convex/runtime/execute.ts` only; that file holds no queries/mutations and is imported by nothing else. |
| Auth provider | "ConvexProviderWithAuth (or the provider matching the existing auth setup — confirm)" | Existing setup is **better-auth 1.7.3** (email + password). The Convex Better Auth component (`@convex-dev/better-auth` 0.12.5) peer-requires **`better-auth >=1.6.11 <1.7.0`**; no published tag supports 1.7. Provider is `ConvexBetterAuthProvider` from `@convex-dev/better-auth/react`, not `ConvexProviderWithAuth`. | **Downgrade better-auth to `~1.6.15`** (the version the component's own Next.js guide pins) and use the component. Users then live in the component's tables; `users` in our schema is a thin mirror (see §3). **Needs your OK.** |
| Users table | "users → same name" | Better Auth component owns the auth user table. | Keep an app-side `users` mirror (`authId`, `email`, `name`) written by the component's `onCreate`/`onUpdate` triggers; league tables reference users by `authId: string`. |
| Snapshots | "snapshot row is a logical timestamp; normalized tables are read as-of" | The frozen payload is ~435 KB for 12 teams. PRD 5.3 requires every agent in a window to see the *identical* data, and PRD 6.6 requires replay. As-of reads across `player_projections` (3,300+ rows × vintages) at the start of every run cost more reads and are harder to prove identical. | **Deviation:** store the frozen payload in `snapshot_chunks` (≤ ~200 KB each, one indexed query to load) plus `snapshot_digests`. The snapshot row stays metadata-only as the brief asks. Normalized tables still carry `effectiveAt` and the pinned `projectionEffectiveAt` is recorded, so as-of replay remains possible. |
| `windows.open` as one mutation | "open is a mutation: create snapshot, digest, runs, enqueue" | Building the payload reads ~3,300 projection rows, 12 rosters, games, news; mutations get **1 s of user code**. | `open` (mutation) creates the snapshot in `building` status and schedules `internal.snapshot.build` (action) which writes chunks/digest through batched mutations, then calls `internal.windows.dispatch` (mutation) to create the runs and enqueue Workpool jobs. Same observable behaviour, two hops. |
| `league_rules` | "object field on leagues unless edited independently" | It is edited independently (commissioner console, 19 procedures) and read by every run. | Separate `league_rules` table with `by_leagueId`. |
| `model_week_rollups` key | `(modelId, season, week)` | The league cost page needs spend-by-model *per league*; the benchmark needs it cross-league. | One table, `leagueId` optional: a per-league row and a global row per event. |
| Forum "hot" index | index `(leagueId, score, createdAt)` for hot/top | Hot is time-decayed (`score/(ageHours+2)^1.5`), not indexable. | `by_leagueId_score` serves **top**; **hot** reads the newest 200 posts via `by_leagueId_createdAt` and ranks in the query (bounded). |
| Trace search | (not addressed) | Current search is a Postgres `ILIKE` over `run_steps` text — no Convex equivalent. | `run_search_docs` with a search index; one small doc per run written by persistStep/finalize. |
| Workflow component | listed as an available primitive | Not needed: window lifecycle is scheduler + two mutations; runs are Workpool jobs. | Not used. Noted so the report can say why. |
| Paths in the brief | `src/agent/**`, `docs/fantasy-bench-prd.md` | Repo has `lib/agent/**` and `prd.md`. | Move `lib/agent/**` → `convex/runtime/`; update `prd.md` §6.1–6.6. |
| Workpool `status()` | — | Returns only `pending/running/finished`; `onComplete` is the only place with the result, and it runs as its **own** transaction. | Finalization lives entirely in `onComplete`, as the brief specifies. |
| Scheduled actions | — | Scheduled **actions** run at most once with no retry; scheduled **mutations** exactly once. | Every `runAt` target is a mutation; actions are only ever reached through a mutation or the Workpool. |
| `ctx.db` API | — | Table name is now the first argument (`ctx.db.get("runs", id)`); id-only overloads are deprecated. | Use the new form everywhere. |

**AI SDK:** the executor's surface (`generateText` with `instructions`, `messages`, `tools`, `stopWhen: stepCountIs`, `prepareStep`, `onStepEnd`, `abortSignal`, `maxRetries`, `reasoning`, `toolChoice`; step fields `usage.inputTokens/outputTokens/inputTokenDetails.cacheReadTokens/outputTokenDetails.reasoningTokens`, `performance.stepTimeMs`, `responseMessages`) was confirmed against `node_modules/ai/dist/index.d.ts` (7.0.93). No streaming, no `providerOptions`, no dynamic imports. It ports to an action unchanged except for how it persists.

**Environment state:** Postgres holds only the seed data (`npm run db:seed`, `db:seed-demo`) plus smoke-test runs; no live league. **No data migration.** The `legacyId` fields exist only so the port of `scripts/seed*.ts` can assert parity against the old seed; they go in cleanup.

## 2. Inventory (migration checklist)

Counts from the repo scan: 65 tRPC procedures (30 reached by the UI, 35 only duplicated in server components), 35 RSC pages (12 hit Drizzle directly), 48 Drizzle tables, 111 indexes/constraints, 2 crons, 7 route handlers, 6 scripts, 78 runtime write sites, 31 query-time aggregations.

### 2.1 tRPC procedures → Convex functions

Auth column: `read` = league readable (member, or anyone if `isPublic`); `member` = league member; `owner` = team owner or commissioner; `commish` = commissioner; `user` = signed in. Every public function re-implements exactly the check the tRPC middleware did (`lib/trpc/init.ts`) and Phase 3 ports the auth tests one-for-one.

| tRPC | → Convex function | Kind | Auth | Notes |
|---|---|---|---|---|
| league.create | `leagues.create` | mutation | user | creates league, rules, membership, weeks, teams, default configs; schedules nothing until draft |
| league.get | `leagues.get` | query | read | |
| league.listMine | `leagues.listMine` | query | user | `league_members.by_userId` → leagues by id |
| league.join | `leagues.join` | mutation | user | |
| config.get | `configs.get` | query | read | |
| config.versions | `configs.versions` | query | read | |
| config.version | `configs.version` | query | read | |
| config.diff | `configs.diff` | query | read | diff computed in the query (pure) |
| config.save | `configs.save` | mutation | owner | edit-lock logic unchanged; inserts immutable version |
| config.setNote | `configs.setNote` | mutation | owner | |
| config.lockStatus | `configs.lockStatus` | query | read | |
| config.estimate | `configs.estimate` | query | read | pure |
| skills.list | `skills.list` | query | public | search index for `query`; `by_authorUserId` for mine |
| skills.get | `skills.get` | query | public | |
| skills.create | `skills.create` | mutation | user | |
| skills.update | `skills.update` | mutation | user (author) | |
| skills.fork | `skills.fork` | mutation | user | |
| cost.team | `ledger.teamDashboard` | query | read | reads `team_week_rollups`, `team_standings`, `league_rules` only |
| cost.league | `ledger.leagueDashboard` | query | read | reads `team_week_rollups`, `model_week_rollups`, `league_week_rollups`, top runs via `runs.by_leagueId` bounded |
| cost.benchmark | `ledger.benchmark` | query | read | `model_week_rollups` + `team_standings` |
| views.home | `views.home` | query | read | composed of bounded index reads (see §5) |
| views.standings | `views.standings` | query | read | `team_standings.by_leagueId_season` |
| views.teams | `views.teams` | query | read | |
| views.team | `views.team` | query | read | |
| views.matchups | `views.matchups` | query | read | |
| views.matchup | `views.matchup` | query | read | |
| views.draftBoard | `draft.board` | query | read | reactive draft board (replaces `draft-refresher` polling) |
| views.waivers | `waivers.results` | query | read | |
| views.windowsForWeek | `windows.forWeek` | query | read | |
| views.windowSchedule | `windows.schedule` | query | read | |
| traces.list | `runs.list` | query (paginated) | read | index chosen by the most selective filter; `paginate` |
| traces.search | `runs.search` | query | read | `run_search_docs.search_text` with filter fields |
| traces.get | `runs.get` + `runs.steps` (paginated) + `runs.stepPayload` | query | read | trace viewer subscribes to the run doc and pages steps; payloads lazy |
| traces.modelOptions | `runs.modelOptions` | query | read | from `model_week_rollups.by_leagueId_season_weekNo` (no scan of runs) |
| traces.export | `runs.export` | query | read | assembled from run + steps + payloads; 16 MiB return cap → team export streams per run |
| traces.exportTeam | `runs.exportTeamPage` | query (paginated) | read | route handler pages through it |
| commissioner.settings | `commissioner.settings` | query | commish | |
| commissioner.updateRules | `commissioner.updateRules` | mutation | commish | immutability + change log unchanged |
| commissioner.setModelAllowlist | `commissioner.setModelAllowlist` | mutation | commish | |
| commissioner.setBudgets | `commissioner.setBudgets` | mutation | commish | |
| commissioner.setEditLock | `commissioner.setEditLock` | mutation | commish | also reschedules the week's `unlockJobId` |
| commissioner.setWindowOverrides | `commissioner.setWindowOverrides` | mutation | commish | cancels + recreates open/close jobs of not-yet-opened windows |
| commissioner.setTransparency | `commissioner.setTransparency` | mutation | commish | |
| commissioner.setInjectionPolicy | `commissioner.setInjectionPolicy` | mutation | commish | |
| commissioner.setFallbacks | `commissioner.setFallbacks` | mutation | commish | |
| commissioner.updateLeague | `commissioner.updateLeague` | mutation | commish | |
| commissioner.inviteLink | `commissioner.inviteLink` | query | commish | |
| commissioner.rotateJoinCode | `commissioner.rotateJoinCode` | mutation | commish | |
| commissioner.joinByCode | `leagues.joinByCode` | mutation | user | |
| commissioner.startDraft | `draft.start` | mutation | commish | schedules first pick window (`leagues.draftJobId`) |
| commissioner.assignOwner | `commissioner.assignOwner` | mutation | commish | |
| commissioner.assignOwnerByEmail | `commissioner.assignOwnerByEmail` | mutation | commish | `users.by_email` |
| commissioner.renameTeam | `commissioner.renameTeam` | mutation | commish | uniqueness via `teams.by_leagueId_name` |
| commissioner.replaceDeprecatedModel | `commissioner.replaceDeprecatedModel` | mutation | commish | one new immutable version per team |
| commissioner.changeLog | `commissioner.changeLog` | query (paginated) | commish | |
| trades.list | `trades.list` | query | read | reactive negotiation feed |
| trades.get | `trades.get` | query | read | |
| trades.castVeto | `trades.castVeto` | mutation | member (owner) | updates `vetoCount`/`approveCount` |
| messaging.listThreads | `messaging.listThreads` | query | read | transparency mode honoured with viewer's team ids |
| messaging.getThread | `messaging.getThread` | query (paginated messages) | read | |
| forum.list | `forum.list` | query (paginated) | read | hot/new/top per §1 |
| forum.get | `forum.get` | query | read | post + comments (`by_postId_createdAt`, bounded 500) |
| forum.vote | `forum.vote` | mutation | member | optimistic update on the client |
| forum.hide | `forum.hide` | mutation | commish | |
| forum.karma | `forum.karma` | query | read | `teams.by_leagueId` |

Adds not present in tRPC today (needed by the reactive UI or the scheduler): `users.me`, `users.upsertFromAuth` (internal), `ledger.verifyTeamWeek` (internalAction + commissioner-facing action), `windows.reschedule` (internal), `runs.cancel` (commish, cancels the Workpool job).

### 2.2 Server-component pages → read strategy

All 35 pages are RSCs; 12 call Drizzle directly. Rule: first paint via `preloadAuthQuery`/`fetchAuthQuery` (Better Auth wrappers of `preloadQuery`/`fetchQuery`), then a client component with `usePreloadedQuery` where the page must be live.

| Page(s) | Preload + live? | Functions |
|---|---|---|
| `/leagues` (list), `/skills*`, `/bench` | fetch only | `leagues.listMine`, `skills.list/get`, `ledger.modelPrices` |
| `/leagues/[id]` home | preload + live | `views.home` |
| standings, teams, team page | preload + live | `views.standings`, `views.teams`, `views.team` |
| config editor, versions, diff, compare | fetch; editor client uses `useQuery` for estimate/lock | `configs.*` |
| film room | fetch | `metrics.filmRoom` (from `team_week_metrics`, `team_week_rollups`, `waivers.results`, `trades.list`) |
| cost | preload + live | `ledger.teamDashboard`, `ledger.leagueDashboard`, `ledger.benchmark` |
| traces list / trace | preload + live (run doc + paginated steps) | `runs.list/search/get/steps/stepPayload` |
| draft | preload + live | `draft.board` (removes `draft-refresher.tsx` polling) |
| waivers, matchups | preload + live | `waivers.results`, `views.matchups/matchup` |
| trades, trade, threads, thread, commons, post | preload + live | `trades.*`, `messaging.*`, `forum.*` |
| settings | fetch; tabs mutate via `useMutation` | `commissioner.settings` |
| join/[code] | fetch + mutation | `leagues.byJoinCode`, `leagues.joinByCode` |

### 2.3 Drizzle tables → Convex tables

| Postgres | Convex | Change |
|---|---|---|
| user, session, account, verification | *(Better Auth component)* + `users` mirror | app references users by `authId` string |
| leagues | leagues | + `joinCode`, `draftJobId` |
| league_rules | league_rules | same fields |
| league_rule_changes | league_rule_changes | |
| league_members | league_members | |
| teams | teams | |
| weeks | weeks | + `rolloverJobId`, `unlockJobId` |
| matchups | matchups | |
| team_results | team_results + **team_standings** (new rollup) | standings maintained by the scoring mutation |
| players | players | `raw` jsonb → `externalIds` (ids only); search index on name |
| nfl_games | nfl_games | |
| player_stats_weekly | player_stats_weekly | |
| player_projections | player_projections + **player_projection_latest** (new) | latest upserted in the same ingest mutation |
| news_items | news_items | + `dedupeKey` |
| injury_designations | injury_designations | |
| *(ownership held in snapshot only)* | **player_ownership** (new) | needed by the builder |
| custom_providers | custom_providers | + `slug` |
| roster_slots | roster_slots | + `leagueId` |
| lineups (versioned, = lineup_history) | lineups | + `leagueId` |
| transactions | transactions | |
| agent_configs | agent_configs | + `leagueId` |
| config_versions + config_version_skills | config_versions (`skillIds[]`) | immutable |
| skills | skills | + `usageCount` denormalized |
| windows | windows | + `openJobId`, `closeJobId`, `runCount`, `terminalRunCount`; `weekNo` non-null (0 for draft) |
| snapshots (payload+digest jsonb) | snapshots (meta) + **snapshot_digests** + **snapshot_chunks** | see §1 |
| runs | runs | − `claimedAt`, `leaseExpiresAt`, `messages`; + `workId`, `attempt`, `lastPersistedStep`, denormalized `windowType/windowLabel/weekNo`, `fallbackOfRunId` |
| run_steps | run_steps + **run_step_payloads** | large tool results split out |
| run_actions | run_actions | + `leagueId`, `teamId` |
| *(SQL ILIKE search)* | **run_search_docs** | search index |
| waiver_claims | waiver_claims | |
| draft_picks, auction_nominations, auction_bids | same | |
| trades + trade_items | trades (`items[]`) | + `vetoCount`, `approveCount` |
| trade_events, trade_votes | same | |
| threads, messages | same | messages + `leagueId`; threads + `messageCount` |
| forum_posts, forum_comments, forum_votes | same | scores denormalized (already were) |
| usage_events | usage_events | + `season`, `weekNo`, `computedCostUsd` |
| model_prices, budgets | same | |
| budget_rollups | **team_week_rollups, model_week_rollups, league_week_rollups** | per §5 of the brief |
| *(none)* | **team_week_metrics**, **ingest_state** | new |

54 tables, 130 indexes, 3 search indexes. No `v.any()` except the six documented AI-SDK/payload fields (`snapshot_chunks.data`, `run_steps.responseMessages/toolCalls/toolResults`, `run_step_payloads.payload`, `run_actions.result`, `trades.fairnessDetail`).

### 2.4 Entry points → Convex scheduling

| Today | → Convex |
|---|---|
| `vercel.json` `/api/cron/tick` every 5 min | **Removed.** Window open/close are `ctx.scheduler.runAt` jobs stored on the window. Week rollover (`internal.weeks.rollover`: materialize next week's windows + schedule their jobs, mark week statuses) is scheduled per league at each week's `startsAt`. Config unlock apply is scheduled per league per week at the unlock instant. Draft picks chain: each pick's close schedules the next pick's open. Scoring/finalize: `crons.ts` `internal.scoring.tickAll` every 15 min on game days (Thu/Sun/Mon ET, guarded inside) fans out one `internal.scoring.scoreLeague` mutation per in-season league; finalize triggers playoffs + commissioner tasks. Lease reaper: **gone** (Workpool owns retries; the close mutation times out stragglers). |
| `/api/cron/ingest` every 15 min | `crons.ts`: `internal.ingest.pull` every 15 min + a second every-5-min cron with a game-day guard. `pull` is an action that fetches providers and writes through `internal.ingest.upsertPlayersBatch` etc. in batches of ≤ 500 docs. |
| `POST /api/runs/[runId]/execute` | **Removed.** `internal.runtime.executeRun` internalAction enqueued by the Workpool from `windows.dispatch`. |
| `/api/auth/[...all]` | Better Auth component handler (`convexBetterAuthNextJs().handler`). |
| `/api/trpc/[trpc]` | **Removed.** |
| `/api/leagues/.../export` (2 routes) | Kept as Next route handlers calling `fetchAuthQuery(api.runs.export…)` (downloads need a real HTTP response). |
| `scripts/seed.ts`, `seed-demo.ts`, `ingest.ts` | `convex/seed.ts` internal mutations/actions run via `npx convex run`; `scripts/*` become thin wrappers. |
| `scripts/smoke-e2e.ts` | `npx convex run windows:openNow` + observe; kept as the e2e harness. |
| `scripts/migrate.ts`, `reset.ts` | **Removed** (Convex schema push). |

### 2.5 Runtime write sites → mutations

| Today (78 sites, 7 in the agent) | → Convex |
|---|---|
| `claimRun` (conditional UPDATE) | gone — Workpool claims; `executeRun` marks `running` via `internal.runs.markRunning` |
| `finalize` (runs) | `internal.runs.onComplete` (Workpool `defineOnComplete`), the only writer of terminal status |
| `executeRun` mid-run patch (`promptSections`, `modelId`) | `internal.runs.markRunning` |
| `onStepEnd` → `run_steps` insert + `recordUsage` | **`internal.runs.persistStep`** — one mutation: insert `run_steps` (+ `run_step_payloads` overflow), call `ledger.recordStep` (usage_events + 3 rollups), commit the step's validated write-tool actions into `run_actions`, advance `lastPersistedStep`, refresh `run_search_docs` |
| `commitAction` insert/update (`run_actions`) | inside `persistStep` (see resume design §4) with a pre-check query `internal.runs.actionResult` so a replay returns the stored result and never re-commits |
| `set_rationale` | patch inside `persistStep` |
| lineup `commitLineup` | `internal.lineups.commit` (called from the write tool via `ctx.runMutation`) |
| ledger `recordUsage`/`bumpRollup`/`notifyCommissionerOfCap` | `internal.ledger.recordStep` (+ cap notice via `league_week_rollups.capNotifiedAt`) |
| waivers (12), draft (18), trades (17), messaging (5), forum (11) | one internal mutation per service entry point (`waivers.submit`, `waivers.drop`, `waivers.process`, `draft.recordPick`, `draft.nominate`, `draft.bid`, `draft.resolveLot`, `trades.propose`, `trades.respond`, `trades.expireForWindow`, `trades.processReviews`, `trades.castVeto`, `messaging.send`, `forum.createPost`, `forum.createComment`, `forum.vote`, `forum.hide`); each is already transactional today and maps to exactly one mutation |
| 21 non-transactional sites | become transactional for free (each mutation is a transaction) |

### 2.6 Query-time aggregations (31) → rollups

| Aggregation | Replacement |
|---|---|
| cost A1–A6, A12, A14, A15 (sums over usage_events) | `team_week_rollups`, `model_week_rollups`, `league_week_rollups` |
| A7–A10, A13 (sums over team_results) | `team_standings` (maintained by `scoring.scoreLeague`) |
| A11, A29 (counts over runs by model) | `model_week_rollups.runCount` |
| A16 draft running cost | `windows`/`runs` totals → `leagues.draftCostUsd` maintained in `onComplete` for draft runs |
| A17 draft progress counts | `draft.board` reads picks via `by_leagueId_overallNo` (≤ 224 docs) |
| A18 trade item counts | `trades.items.length` |
| A19, A22, A23 (budget_rollups sums) | rollup tables directly |
| A20, A21 window run counts | `windows.runCount`, `windows.terminalRunCount` |
| A24, A25 waiver counts | `waivers.results` reads `by_leagueId_weekNo` (≤ teams×10) |
| A26–A28, A30 run/action counts | `runs.committedActionCount`, `rejectedActionCount`; list is paginated, no total count (UI shows "more") |
| A31 remaining budget | `team_week_rollups` + `league_week_rollups` read before every model step |

## 3. Auth and identity

- `convex/auth.ts` per the component guide (`betterAuth` from `better-auth/minimal`, `convex({ authConfig })` plugin, `emailAndPassword`), `convex/http.ts` registers routes, `convex/auth.config.ts` uses `getAuthConfigProvider()`.
- Client: `ConvexBetterAuthProvider` wraps the app; server components use `preloadAuthQuery`/`fetchAuthQuery`/`getToken` from `convexBetterAuthNextJs()`.
- The component's user `onCreate`/`onUpdate` triggers upsert our `users` mirror (`authId`, `email`, `name`). If triggers turn out unavailable in 0.12.5, fallback is a `users.ensure` mutation called once after sign-in (verified in Phase 3).
- Authorization helpers in `convex/lib/auth.ts`: `requireUser(ctx)`, `requireLeagueRead(ctx, leagueId)`, `requireMember`, `requireOwnerOrCommissioner(ctx, teamId)`, `requireCommissioner`. Ported test-for-test from `lib/trpc/init.ts` and the existing auth tests.

## 4. Scheduling and runtime design

**Window lifecycle.** `leagues.create`/`weeks.rollover` insert windows and schedule `internal.windows.open` at `opensAt` and `internal.windows.close` at `closesAt`, storing both job ids. `windows.reschedule` cancels and recreates. `open` (mutation): status `open`, insert `snapshots{status:'building'}`, schedule `internal.snapshot.build` (action) now. `build` writes chunks + digest in ≤ 8 mutations, marks `ready`, then runs `internal.windows.dispatch` (mutation): one `runs` doc per team (pending, `lastPersistedStep: -1`), `pool.enqueueAction(internal.runtime.executeRun, { runId }, { onComplete: internal.runs.onComplete, context: { runId } })`, store `workId`. If `build` fails, `dispatch` still creates runs and `onComplete` marks them `failed` so the close fallback applies (fail safe). `close` (mutation): mark non-terminal runs `timed_out` and cancel their Workpool jobs, apply fallbacks (lineup → safety autopilot from the snapshot), expire proposals for the last round of a trade window, process waivers, compute `team_week_metrics`, set `closed`.

**Workpool.** One pool `runs` with `maxParallelism: 24`, `retryActionsByDefault: true`, `defaultRetryBehavior: { maxAttempts: 3, initialBackoffMs: 2000, base: 2 }`, `statusTtl: 7 days`. Total parallelism stays under the Pro guidance of 100 (this is the only pool). `onComplete` (`internal.runs.onComplete`, a mutation): on success → status from the action's return (`succeeded`/`partial`/`fallback`/`timed_out`), on failure after retries → `failed` and, if the league has a `fallbackModelId` and the run has no `fallbackOfRunId`, enqueue a new run on the fallback model flagged `fallbackApplied.kind = 'fallback_model'`.

**executeRun (internalAction).** Loads run, window, snapshot chunks (reassembled into `SnapshotPayload`), config version + skills, rules, remaining budget (rollups) through `ctx.runQuery(internal.runtime.loadRunContext)`. Builds tools and prompt exactly as today (`lib/agent/tools`, `prompt.ts` moved to `convex/runtime/`). If `lastPersistedStep >= 0`, loads the persisted steps' `responseMessages` and resumes with `stopWhen: stepCountIs(maxSteps - persisted)`. Each write tool first calls `internal.runs.actionResult(runId, toolCallId)`; a hit returns the stored result. Otherwise it validates against the in-memory snapshot and commits through the service mutation (`ctx.runMutation`), recording the action in a per-step buffer. `onStepEnd` calls `internal.runs.persistStep` with the step document, usage, and the buffered actions — one transaction. Budget check in `prepareStep` uses the rollup-derived remaining figures loaded at start, updated with this run's own accumulated spend. Wall clock: `AbortController` + timer at the window's per-run budget (`league_rules.runWallclockSeconds`, default 300 / 480); on abort the action returns `timed_out` after persisting the completed steps. The action's return value drives `onComplete`; it never writes terminal status itself.

**Idempotency on retry.** A retried action re-runs `executeRun` with the same `runId`; steps ≤ `lastPersistedStep` are not re-executed and their actions are served from `run_actions`. A tool call whose mutation committed but whose `persistStep` did not land is the one hazard: the service mutations therefore also write their own `run_actions` row inside the same transaction as the domain write (the action row is the idempotency key, exactly as today), and `persistStep` upserts rather than inserts. Result: no duplicate `run_actions`, no duplicate `usage_events` (keyed by `(runId, stepIndex)` with an existence check).

**Scoring, standings, commissioner.** `scoring.scoreLeague` (mutation, per league, bounded by 12 teams × lineup) writes `team_results`, `matchups`, and upserts `team_standings`; on finalize it schedules `internal.commissioner.weekly` (action → model call → posts via mutations). Draft recap and trade narrative remain best-effort actions scheduled from the relevant mutation.

**Ingestion.** `crons.ts`: `internal.ingest.pull` every 15 min; `internal.ingest.pullGameDay` every 5 min with a Thu/Sun/Mon ET guard. `pull` fetches Sleeper/ESPN/nflverse, diffs against `ingest_state`, and writes in batches of ≤ 500 documents per mutation (players ~3,300 → 7 mutations; projections similar). `player_projection_latest` is upserted in the same mutation as the history row.

## 5. Index list with the query that justifies each

Only indexes with a concrete reader are defined. `_creationTime` is the implicit last field everywhere.

| Table.index | Justifying query |
|---|---|
| users.by_authId | every authenticated call maps identity → user |
| users.by_email | commissioner.assignOwnerByEmail |
| leagues.by_slug / by_joinCode | seed lookup; join/[code] page |
| leagues.by_commissionerUserId | leagues.listMine (commissioner side) |
| leagues.by_status | scoring.tickAll, ingest fan-out (in-season leagues, bounded by league count, paginated) |
| league_rules.by_leagueId | every league read, every run |
| league_rule_changes.by_leagueId | commissioner.changeLog (paginated, newest first) |
| league_members.by_leagueId_userId / by_userId | auth checks; leagues.listMine |
| teams.by_leagueId / by_leagueId_name / by_ownerUserId | league pages; renameTeam uniqueness; "my team" |
| weeks.by_leagueId_weekNo / by_leagueId_startsAt | currentWeekNo (range startsAt ≤ now, take 1 desc); week pages |
| matchups.by_leagueId_weekNo / by_home… / by_away… | matchups page; team page schedule |
| team_results.by_teamId_weekNo / by_leagueId_weekNo | film room; scoring |
| team_standings.by_teamId_season / by_leagueId_season | standings, cost per win/point |
| players.by_sleeperId / by_position_searchRank / by_nflTeam / search_fullName | ingest upsert; free-agent pool fallback; bye/kickoff join; skill picker & player search UI |
| nfl_games.by_gameId / by_season_week | ingest upsert; snapshot builder (≤ 16 games) |
| player_stats_weekly.by_playerId_season_week / by_season_week | scoring (per rostered player); builder's last-week points |
| player_projections.by_playerId_week_effectiveAt | as-of replay (PRD 6.6) |
| player_projections.by_season_week_source_effectiveAt | ingest "newest vintage" check |
| player_projection_latest.by_playerId_season_week_source / by_season_week_source_projectedPointsPpr | builder: rostered players by id; top-250 free agents by projection desc (take 400, filter rostered) |
| news_items.by_effectiveAt / by_playerId_effectiveAt / by_dedupeKey | builder (last 7 days, take 60); get_news per player; ingest dedupe |
| injury_designations.by_playerId_effectiveAt / by_season_week_effectiveAt | builder current designations; ingest change detection |
| player_ownership.by_season_week_playerId | builder |
| custom_providers.by_leagueId / by_teamId | executeRun tool set |
| roster_slots.by_teamId / by_teamId_playerId / by_leagueId_playerId | rosters; drop/trade validation; waiver "is free agent" check |
| lineups.by_teamId_weekNo_version / by_setByRunId | current lineup = last of range; trace → lineup link |
| transactions.by_leagueId / by_teamId / by_tradeId / by_leagueId_playerId | activity feed (paginated); team page; trade completion audit; anti-churn check |
| agent_configs.by_teamId / by_leagueId | config pages; applyPending per league |
| config_versions.by_configId_versionNo / by_leagueId | versions list, previous version; replaceDeprecatedModel |
| skills.by_slug / by_authorUserId / by_visibility / search_name | skill pages; mine; library; search |
| windows.by_leagueId_label_weekNo_roundNo | materialize idempotency |
| windows.by_leagueId_weekNo_type / by_leagueId_status / by_leagueId_opensAt | windows.forWeek; close-time trade sibling lookup; home page "next window" (range opensAt ≥ now, take 3) |
| snapshots.by_leagueId_takenAt / by_windowId | latest snapshot; window → snapshot |
| snapshot_digests.by_snapshotId, snapshot_chunks.by_snapshotId_kind_part | executeRun load (one range, ≤ 8 docs) |
| runs.by_windowId_status | dispatch, close (non-terminal runs), window counts |
| runs.by_teamId / by_leagueId / by_leagueId_teamId / by_leagueId_status / by_leagueId_weekNo / by_leagueId_windowType / by_leagueId_modelId / by_leagueId_kind | traces list (one index per primary filter, paginated); team recent runs; get_my_history (take 10); commissioner runs |
| run_steps.by_runId_stepIndex | trace viewer pagination; resume; export |
| run_step_payloads.by_runId_stepIndex_toolCallId | lazy payload load |
| run_actions.by_runId_toolCallId / by_runId_stepIndex | idempotency check; trace "committed actions" |
| run_search_docs.by_runId / search_text | refresh on finalize; traces.search |
| waiver_claims.by_windowId / by_windowId_teamId / by_teamId_weekNo / by_leagueId_weekNo | processing; replace-own-claims; film room; waivers page |
| draft_picks.by_leagueId_overallNo / by_leagueId_teamId / by_leagueId_playerId | board, next pick; team's picks; "already drafted" |
| auction_nominations.by_leagueId_lotNo / by_leagueId_status; auction_bids.by_nominationId_teamId | auction state machine; sealed-bid upsert |
| trades.by_leagueId / by_leagueId_status / by_leagueId_weekNo / by_proposerTeamId_status / by_recipientTeamId_status / by_threadId / by_windowId_status / by_status_reviewEndsAt | feed + filters (paginated); open-proposal cap; inbox; thread cards; expire at close; review processing (range reviewEndsAt ≤ now) |
| trade_events.by_tradeId; trade_votes.by_tradeId_userId | detail timeline; one vote per user |
| threads.by_leagueId_teamAId_teamBId / by_leagueId_lastMessageAt / by_teamAId / by_teamBId | canonical pair lookup; feed; inbox (both sides) |
| messages.by_threadId_createdAt / by_leagueId_createdAt / by_runId | thread (paginated); league feed; trace links |
| forum_posts.by_leagueId_createdAt / by_leagueId_score / by_leagueId_flair_createdAt / by_teamId_createdAt | new + hot (bounded 200); top; flair filter; team rate limit (last 24 h) |
| forum_comments.by_postId_createdAt / by_teamId_createdAt | post page; rate limit |
| forum_votes.by_targetType_targetId_voterUserId / …_voterTeamId | one vote per voter |
| usage_events.by_runId_stepIndex / by_teamId_createdAt / by_leagueId_createdAt / by_teamId_season_weekNo / by_leagueId_season_weekNo | dedupe on retry; audit pages; reconciliation (pages one team-week) |
| model_prices.by_modelId_effectiveFrom | price at event time (range ≤ now, take 1 desc) |
| budgets.by_leagueId_teamId_period | budget lookup |
| team_week_rollups.by_teamId_season_weekNo / by_leagueId_season_weekNo | budget check; team dashboard; league spend-by-team |
| model_week_rollups.by_modelId_season_weekNo / by_leagueId_modelId_season_weekNo / by_leagueId_season_weekNo | benchmark; upsert; league spend-by-model |
| league_week_rollups.by_leagueId_season_weekNo | league cap check; cost trend |
| team_week_metrics.by_teamId_season_weekNo / by_leagueId_season_weekNo | film room; benchmark |
| ingest_state.by_key | ingest cron |

## 6. File layout

```
convex/
  schema.ts  convex.config.ts (workpool + betterAuth)  auth.ts  auth.config.ts  http.ts  crons.ts
  lib/auth.ts (authorization helpers)  lib/time.ts (ported)  lib/validators.ts
  users.ts  leagues.ts  configs.ts  skills.ts  commissioner.ts  views.ts
  windows.ts  weeks.ts  snapshot.ts  draft.ts  waivers.ts  trades.ts  messaging.ts  forum.ts
  runs.ts (list/get/steps/persistStep/onComplete/search)  ledger.ts (recordStep, dashboards, verify)
  scoring.ts  metrics.ts  ingest.ts  providers/ (ported fetchers)  seed.ts
  runtime/ (moved from lib/agent: execute.ts ["use node" if required], tools/, prompt.ts, model.ts, mock-model.ts, untrusted.ts, lineup.ts, snapshot-load.ts)
app/, components/  — unchanged routes; data via Convex hooks / preloadAuthQuery
lib/  — keeps pure modules only (snapshot types, models catalog, scoring table, classifier, time)
```

## 7. Phasing and checks

1. **Plan** — this document + `convex/schema.ts`. *Stop here.*
2. **Schema and read paths** — `npx convex dev` (local deployment, no account needed), schema pushed, all queries in §2.1 implemented, seed ported to `convex/seed.ts`, read pages switched to Convex (preload + hooks). Checks: every read query returns the tRPC shape for the seed league (parity tests with `convex-test`), the limits test against a 50-league seed, pages render from Convex with Postgres still serving writes.
3. **Write paths** — Better Auth component (better-auth pinned to `~1.6.15`), all mutations, auth parity tests, forum/messaging/trades/commissioner UI on `useMutation` with optimistic votes. Old runtime and tick still write to Postgres for runs. Checks: auth matrix tests, forum/trade/messaging integration tests ported.
4. **Ledger and rollups** — `ledger.recordStep`, three rollup tables, `team_week_metrics`, reconciliation action, dashboards on rollups. Checks: reconciliation equals event sums for every team-week in a simulated season.
5. **Scheduler and runtime** — windows on scheduled functions, Workpool, `executeRun` action (default-runtime probe first), resume, budgets, wall clock, fallback model, ingest crons; old cron and execute route disabled. Checks: scheduler test (window in 10 s), resume test (throw after step 3), budget test, lock test, load test (600 runs at parallelism 24 finish before the deadline; raise if not), end-to-end simulated week diffed against a golden state recorded from the current system before Phase 2 starts.
6. **Cleanup** — remove tRPC, Drizzle, postgres, drizzle-kit, vercel.json crons, polling, `legacyId`; update `prd.md` §6.1–6.6; write `docs/migration-report.md`.

A golden state for step 5 is captured **now**, before any change, by running the current smoke flows and exporting the league (`scripts/smoke-e2e.ts` + a JSON dump) so the diff has a baseline from the old system.

## 8. Decisions needed before Phase 2

1. **better-auth downgrade to `~1.6.15`** so the Convex Better Auth component can be used (only option that keeps the existing email + password setup). Alternative: Convex Auth (beta) with a re-written login flow.
2. **Snapshot storage as chunked frozen payload** (proposed) vs. as-of reads from normalized tables (brief). Frozen chunks are simpler, provably identical across teams, and keep the tools untouched.
3. **Convex deployment for development:** local deployment via `npx convex dev` (no account) is enough for Phases 2–5; the load test at parallelism 24 needs a cloud Pro deployment (free tier caps total parallelism at 20). Say if a cloud deployment exists or should be created.
4. **`"use node"` for `executeRun`** is expected because the default runtime has no `setTimeout`; confirming by probe in Phase 5 is part of the plan, but if you want to forbid Node up front, the wall-clock abort has to be reimplemented with `AbortSignal.timeout`-style polling and AI SDK `maxRetries` set to 0 with retries done by the Workpool instead. I recommend allowing Node for that one file.
