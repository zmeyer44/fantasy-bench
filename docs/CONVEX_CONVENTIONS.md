# Convex conventions

Read `docs/ARCHITECTURE.md` (the engineering contract) and `docs/CONVEX_NOTES.md` (verified API
reference; **do not use any Convex API that is not in it without checking the docs first**). This
file is the day-to-day contract for everyone writing code under `convex/`.

## Environment

- The deployment every command targets is `CONVEX_DEPLOYMENT` in `.env.local` (`.env.example`
  explains it, and which variables live on the deployment instead). Push with
  `npm run convex:push` (= `npx convex dev --once`); run functions with
  `npx convex run <file>:<fn> '<json args>'`; inspect data with `npx convex data <table>`.
- Several people push to the same dev deployment concurrently. A push deploys the whole `convex/`
  directory, so **never leave `convex/` in a non-compiling state** for long; run `npm run typecheck`
  before pushing. Data you seed is visible to everyone; use the shared demo league rather than
  private fixtures on the deployment, and use `convex-test` for isolated fixtures.
- Function tests: `convex/**/*.test.ts` with `convex-test`, run by `npm test` (Edge Runtime).
  That is the whole suite — `test:convex` is an alias.

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
  (the view type the module declares). Shared validators live in `convex/lib/validators.ts`;
  enum validators come from `convex/schema.ts`.
- `ctx.db.get/patch/replace/delete` take the **table name first** (`ctx.db.get("runs", id)`).
- No `v.any()` except the documented AI-SDK payload fields in the schema.
- **Every read uses an index and a bound**: `.withIndex(...)` + `.take(n)` / `.first()` /
  `.unique()` / `.paginate(paginationOpts)`. `.collect()` is allowed only on ranges that are
  bounded by construction (one league's teams, one run's steps, one snapshot's chunks…) and must
  carry a comment saying why it is bounded. Never `.filter()` without an index range first.
- A function module declares its own return types next to the query that returns them
  (`convex/views.ts#StandingsRow`, `convex/trades.ts#TradeSummary`, …). Only three modules under
  `lib/` may be imported from `convex/` — `lib/models.ts`, `lib/time.ts` and
  `lib/snapshot/types.ts`, all pure and shared with the UI. Everything else the functions need
  lives under `convex/lib/`.
- Dates are epoch milliseconds in the database and in function args/returns. Convert at the UI edge.
- Convex `Id<"table">` values are strings on the wire. Rows carry no id of their own; the golden
  importer keeps its uuid → id map in `.cache/seed-map.<deployment>.json`.
- Public functions never call `fetch`; anything that touches a provider or the AI Gateway is an
  `internalAction`. Scheduled and Workpool targets are always `internal*`.
- Mutations that write an event and its rollup do so in the same handler (see `ledger.recordStep`).
  Config versions are never patched after insert (only `appliedAt`, once).

## Authorization helpers (`convex/lib/auth.ts`)

```ts
requireUser(ctx)                 -> { userId: Id<"users">, user: Doc<"users"> }      // throws UNAUTHORIZED
optionalUser(ctx)                -> same | null
requireLeagueRead(ctx, leagueId) -> { league, viewer, membership | null, isCommissioner } // member, or public league
requireMember(ctx, leagueId)     -> { league, viewer, membership, isCommissioner }   // any role
requireOwnerOrCommissioner(ctx, teamId) -> { ...member access, team }
requireCommissioner(ctx, leagueId) -> member access with isCommissioner
viewerTeamIds(ctx, leagueId, viewer) -> Id<"teams">[]                                  // DM transparency checks
```

Spectators are read-only; owners edit only their own team's config; commissioners administer only
their league; public leagues are readable without a session. Errors are thrown as `ConvexError({ code: "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND" | "BAD_REQUEST", message })`
so the UI can map them.

## Naming

One file per domain, named for the domain (`views.ts`, `runs.ts`, `ledger.ts`, `forum.ts`), and
one function per thing the UI or the runtime asks for (`views.home`, `runs.list`,
`ledger.leagueDashboard`, `forum.vote`). Internal functions live in the same file under a
descriptive name (`internal.windows.open`, `internal.runs.persistStep`).

## Pagination

Paginated queries take `paginationOpts: paginationOptsValidator` plus their filters and return the
`paginate()` result. The UI uses `usePaginatedQuery`. Page sizes are hints, not guarantees.

## Seed contract (`convex/seed.ts`)

Two seeds.

1. `npx convex run seed:base` (internal, idempotent, in-Convex): model prices from `lib/models.ts`,
   the three built-in skills, and nothing else.
2. `npm run seed:convex` (= `npx tsx scripts/seed-convex.ts`, Node, `ConvexHttpClient` against
   `NEXT_PUBLIC_CONVEX_URL`): signs up the demo user through the real Convex Auth password flow
   (`api.auth.signIn`), then imports the golden dataset in batches through a `seed.importBatch`
   mutation guarded by the `SEED_SECRET` deployment env var (it refuses without one), so the 12 MB
   of fixtures never get bundled into the deployment.

The result is the demo league: slug `demo-league`, 12 teams, PPR, snake, public, the players,
projections, runs, steps, actions, usage events (folded into the three rollup tables), trades,
threads, messages, forum posts, waivers, transactions and lineups of
`tests/golden/postgres-week1/*.json`, model prices from `lib/models.ts`, three built-in skills,
demo user `demo@fantasybench.dev` (commissioner + owner of team 1), the drafted rosters, default
lineups, week-1 windows and a ready snapshot (chunked). That dataset is also the parity fixture
(`convex/parity.test.ts`).

**Idempotency.** Rows carry no id of their own, so the importer keeps the golden uuid → Convex id
map in `.cache/seed-map.<deployment>.json` and reads it back on the next run: a second run reports
every table already present and writes nothing. Delete that file only if you have also wiped the
deployment. `npx convex run seed:reset '{}'` wipes the app tables (dev only; it refuses on prod)
and deletes in byte-aware, self-rescheduling batches so a table of 100 KB documents cannot blow the
16 MiB read limit.

## History

The platform was built on PostgreSQL + Drizzle + tRPC + Better Auth and migrated to Convex in six
phases during September 2026, split across lettered work packages (A–H) that owned disjoint sets of
files. Those boundaries are gone: `convex/<domain>.ts` is the unit of ownership now. The plan and
its ownership tables are preserved in `docs/migration-plan.md`, and the phase results — parity,
limits, the scheduler and runtime checks — in `docs/verification/`.

Counters every write path must maintain (found the hard way during that work):
`threads.lastMessageAt/messageCount/flaggedCount`, `trades.vetoCount/approveCount`,
`forum_posts.score/commentCount`, `forum_comments.score`, `teams.karma`, `skills.usageCount`,
`windows.runCount/terminalRunCount`, `runs.committedActionCount/rejectedActionCount`,
`team_standings` (incl. `streak`), the three rollup tables, `team_week_metrics`.
