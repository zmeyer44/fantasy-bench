# Convex conventions (migration Phases 2–6)

Read `docs/migration-plan.md` (the checklist and design) and `docs/CONVEX_NOTES.md` (verified API
reference; **do not use any Convex API that is not in it without checking the docs first**). This
file is the day-to-day contract for everyone writing code under `convex/`.

## Environment

- Dev deployment: `CONVEX_DEPLOYMENT=dev:tidy-peacock-243` in `.env.local` (already set). Push with
  `npm run convex:push` (= `npx convex dev --once`); run functions with
  `npx convex run <file>:<fn> '<json args>'`; inspect data with `npx convex data <table>`.
- Several people push to the same dev deployment concurrently. A push deploys the whole `convex/`
  directory, so **never leave `convex/` in a non-compiling state** for long; run `npm run typecheck`
  before pushing. Data you seed is visible to everyone; use the shared demo league rather than
  private fixtures on the deployment, and use `convex-test` for isolated fixtures.
- Function tests: `convex/**/*.test.ts` with `convex-test`, run by `npm run test:convex`
  (Edge Runtime). The Postgres suite (`npm test`) keeps running until cutover.

## Function style

```ts
import { query, mutation, internalMutation, internalQuery, internalAction } from "./_generated/server";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";

export const get = query({
  args: { leagueId: v.id("leagues") },
  returns: v.union(v.null(), leagueView),   // returns validators are required for public functions
  handler: async (ctx, { leagueId }) => {
    await requireLeagueRead(ctx, leagueId);
    return ctx.db.get("leagues", leagueId);
  },
});
```

- Every function declares `args` validators. Mutations and simple queries also declare `returns`;
  large composite view queries may omit `returns` but must have an explicit TypeScript return type
  (the parity type from `lib/services/*`). Shared validators live in `convex/lib/validators.ts`;
  enum validators come from `convex/schema.ts`.
- `ctx.db.get/patch/replace/delete` take the **table name first** (`ctx.db.get("runs", id)`).
- No `v.any()` except the documented AI-SDK payload fields in the schema.
- **Every read uses an index and a bound**: `.withIndex(...)` + `.take(n)` / `.first()` /
  `.unique()` / `.paginate(paginationOpts)`. `.collect()` is allowed only on ranges that are
  bounded by construction (one league's teams, one run's steps, one snapshot's chunks…) and must
  carry a comment saying why it is bounded. Never `.filter()` without an index range first.
- Return shapes match the existing tRPC/service output types for the same seed data (parity tests).
  Import those types **type-only** from `lib/services/*` (`import type { ... }`) — never import
  runtime code from `lib/` that touches Drizzle. Pure modules under `lib/` (`lib/snapshot/types.ts`,
  `lib/models.ts`, `lib/time.ts`, scoring tables, the classifier) may be imported at runtime.
- Dates are epoch milliseconds in the database and in function args/returns. Convert at the UI edge.
- Convex `Id<"table">` values are strings on the wire; keep `legacyId` populated by the seed so
  parity tests can join old and new rows.
- Public functions never call `fetch`; anything that touches a provider or the AI Gateway is an
  `internalAction`. Scheduled and Workpool targets are always `internal*`.
- Mutations that write an event and its rollup do so in the same handler (see `ledger.recordStep`).
  Config versions are never patched after insert (only `appliedAt`, once).

## Authorization helpers (`convex/lib/auth.ts`, owned by package A)

```ts
requireUser(ctx)                 -> { userId: Id<"users">, user: Doc<"users"> }      // throws UNAUTHORIZED
optionalUser(ctx)                -> same | null
requireLeagueRead(ctx, leagueId) -> { league, viewer, membership | null, isCommissioner } // member, or public league
requireMember(ctx, leagueId)     -> { league, viewer, membership, isCommissioner }   // any role
requireOwnerOrCommissioner(ctx, teamId) -> { ...member access, team }
requireCommissioner(ctx, leagueId) -> member access with isCommissioner
viewerTeamIds(ctx, leagueId, viewer) -> Id<"teams">[]                                  // DM transparency checks
```

These reproduce `lib/trpc/init.ts` exactly: spectators are read-only; owners edit only their own
team's config; commissioners administer only their league; public leagues are readable without a
session. Errors are thrown as `ConvexError({ code: "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND" | "BAD_REQUEST", message })`
so the UI can map them.

## Naming

Files and function names follow `docs/migration-plan.md` §2.1 exactly (e.g. `views.home`,
`runs.list`, `ledger.leagueDashboard`, `forum.vote`). Internal functions use the same file with a
descriptive name (`internal.windows.open`, `internal.runs.persistStep`).

## Pagination

Paginated queries take `paginationOpts: paginationOptsValidator` plus their filters and return the
`paginate()` result. The UI uses `usePaginatedQuery`. Page sizes are hints, not guarantees.

## Phase 2 ownership

| Package | Owns |
|---|---|
| **A: core** | `convex/lib/**`, `convex/users.ts`, `convex/leagues.ts`, `convex/configs.ts`, `convex/skills.ts`, `convex/commissioner.ts` (queries only in Phase 2), `convex/seed.ts` + `convex/seed/**`, `convex/auth.ts`, `convex/auth.config.ts`, `convex/http.ts`, `convex/schema.ts` (additive), tests `convex/*.test.ts` for those |
| **B: league views & runs** | `convex/views.ts`, `convex/windows.ts` (queries + internal materialize), `convex/weeks.ts`, `convex/snapshot.ts` (internal build/load + chunking), `convex/draft.ts` (board query), `convex/waivers.ts` (results query), `convex/runs.ts` (queries), `convex/ledger.ts` (dashboard queries), `convex/metrics.ts` (film-room query), `convex/lib/lineup-pure.ts`, `convex/lib/templates.ts`, tests |
| **C: social** | `convex/trades.ts`, `convex/messaging.ts`, `convex/forum.ts` (queries), tests |
| **D: frontend** (after A–C land) | `app/**`, `components/**`, `lib/convex/**` client wiring |

Shared, append-only: `convex/schema.ts` additive fields are allowed for your own tables only; say so
in your report. `convex/_generated/**` is regenerated by pushes — never edit it.

## Seed contract (package A, `convex/seed.ts`)

Two seeds. (1) `npx convex run seed:base` (internal, idempotent, in-Convex): model prices from
`lib/models.ts`, the three built-in skills, and nothing else. (2) `npx tsx scripts/seed-convex.ts`
(Node, uses `ConvexHttpClient` against `NEXT_PUBLIC_CONVEX_URL`): signs up the demo user through the
real Convex Auth password flow (`api.auth.signIn`), then imports the golden dataset in batches through
a `seed.importBatch` mutation guarded by a `SEED_SECRET` deployment env var (refuses without it), so
the 12 MB of fixtures never get bundled into the deployment. The result is the same demo league
`scripts/seed-demo.ts` produced in Postgres: slug `demo-league`, 12 teams with the same names, PPR, snake, public, players from
`scripts/fixtures/players.sample.json` (+ `.cache/sleeper-players.json` when present), projections
from `scripts/fixtures/projections.sample.json`, model prices from `lib/models.ts`, three built-in
skills, demo user `demo@fantasybench.dev` (commissioner + owner of team 1), the auto-drafted rosters,
default lineups, week-1 windows and a ready snapshot (chunked). `seed:golden` then imports the full golden dataset dumped from the old system
(`tests/golden/postgres-week1/*.json`: runs, steps, actions, usage events → rollups, trades, threads,
messages, forum, waivers, transactions, lineups…) mapping old uuids to Convex ids through `legacyId`,
so every read path has the same data the old tRPC procedures had. That dataset is the parity fixture. `seed:reset` wipes app tables (dev only; refuses on prod).

## Phase 3 ownership (write paths)

| Package | Owns |
|---|---|
| **E: core mutations** | `convex/leagues.ts` (`create` public), `convex/configs.ts` (`save`, `setNote`, internal `applyPending`, `currentForTeam`), `convex/skills.ts` (`create`, `update`, `fork`, usage-count maintenance), `convex/commissioner.ts` (all 16 mutations from plan §2.1 incl. `replaceDeprecatedModel`, `rotateJoinCode`, `startDraft` delegating to `internal.draft.start`), `convex/lib/config_pure.ts` additions, tests |
| **F: social mutations** | `convex/messaging.ts` (`send` internal for the runtime + rate limits), `convex/trades.ts` (`propose`, `respond`, `castVeto`, internal `expireForWindow`, `processReviews`, completion), `convex/forum.ts` (`createPost`, `createComment`, `vote` with optimistic-friendly return, `hide`, karma), `convex/lib/{moderation_pure,fairness_pure}.ts` (ports of `lib/services/moderation/classifier.ts` and `lib/services/trades/fairness.ts`), `convex/commissioner_agent.ts` (narrative/recap actions — Phase 5 wires triggers), tests |
| **G: roster & season mutations** | `convex/lineups.ts` (`commit`, `validate`, `applySafetyAutopilot` internal — uses `lib/lineup_pure`), `convex/waivers.ts` (`submit`, `drop` internal for the runtime; `process` internal), `convex/draft.ts` (`start`, `recordPick`, `nominate`, `bid`, `resolveLot`, `finalize`, `bestAvailable`), `convex/scoring.ts` (`scoreLeague`, `finalizeWeek`, `team_results` + `team_standings` maintenance, playoff seeding/bracket), `convex/standings.ts` (`generateSchedule`), `convex/transactions.ts`, `convex/lib/{scoring_pure,standings_pure}.ts`, tests |
| **H: frontend writes** (after E–G) | every `useMutation(trpc.*)` → Convex `useMutation`/`useAction`; optimistic forum votes; Server Actions replaced by client mutations; `lib/trpc/**` and `app/api/trpc` deleted; better-auth removed from the app |

Counters every write path must maintain (from the Phase 2 reports): `threads.lastMessageAt/messageCount/flaggedCount`, `trades.vetoCount/approveCount`, `forum_posts.score/commentCount`, `forum_comments.score`, `teams.karma`, `skills.usageCount`, `windows.runCount/terminalRunCount`, `runs.committedActionCount/rejectedActionCount`, `team_standings` (incl. `streak`), the three rollup tables (Phase 4), `team_week_metrics` (Phase 5 close).
