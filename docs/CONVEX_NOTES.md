# Convex Engineering Reference

Verified against live docs on **2026-09-08**. Every signature below came from a fetched page; the source URL is cited per section. Do not trust memory over this file — several APIs changed (see **Discrepancies / gotchas** at the end).

## 0. Versions (npm, 2026-09-08)

| Package | Version | Peer requirements |
|---|---|---|
| `convex` | **1.45.0** | — |
| `@convex-dev/workpool` | **0.4.11** | `convex ^1.36.1`, `convex-helpers ^0.1.94` |
| `@convex-dev/workflow` | **0.4.6** | `convex ^1.36.1`, `convex-helpers ^0.1.99`, `@convex-dev/workpool ^0.4.4` |
| `convex-test` | **0.0.56** | `convex ^1.43.0` |
| `@convex-dev/better-auth` | **0.12.5** | `convex ^1.25.0`, `react ^18.3.1 \|\| ^19`, **`better-auth >=1.6.11 <1.7.0`** |
| `@convex-dev/auth` | **0.0.95** | (beta) |
| `better-auth` | 1.7.3 (latest) | — |

---

## 1. Schema & validators

Source: <https://docs.convex.dev/database/schemas.md>, <https://docs.convex.dev/database/types.md>, <https://docs.convex.dev/functions/validation.md>, <https://docs.convex.dev/database/reading-data/indexes.md>, <https://docs.convex.dev/search/text-search.md>

```ts
// convex/schema.ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema(
  {
    messages: defineTable({
      body: v.string(),
      channel: v.string(),
      authorId: v.id("users"),
      meta: v.optional(v.object({ pinned: v.boolean() })),
    })
      .index("by_channel", ["channel"])
      .index("by_channel_author", ["channel", "authorId"])
      .searchIndex("search_body", {
        searchField: "body",          // required, must be v.string()
        filterFields: ["channel"],    // optional, max 16
        staged: false,                // optional: async backfill for big tables
      }),
  },
  { schemaValidation: true, strictTableNameTypes: true }, // both default true
);
```

`defineSchema` options: `schemaValidation` (default `true`; `false` disables runtime document validation) and `strictTableNameTypes` (default `true`; `false` allows access to unlisted tables typed as `any`). Convex auto-adds `_id` and `_creationTime`.

### Validators (`convex/values`)

| Validator | Type | Notes |
|---|---|---|
| `v.id("table")` | `Id<"table">` | |
| `v.null()` | `null` | Convex has no `undefined` value |
| `v.int64()` | `bigint` | −2^63 … 2^63−1 |
| `v.number()` | float64 | IEEE-754 double |
| `v.boolean()` | | |
| `v.string()` | UTF-8 | < 1 MiB encoded |
| `v.bytes()` | `ArrayBuffer` | < 1 MiB |
| `v.array(v.x())` | | **max 8192 elements** |
| `v.object({ a: v.x() })` | | **max 1024 entries** |
| `v.record(keys, values)` | | keys must be ASCII, non-empty, not starting `$`/`_` |
| `v.union(a, b, ...)` | | |
| `v.literal("x")` | | |
| `v.optional(x)` | | field-level optionality |
| `v.any()` | | |
| `v.nullable(x)` | | shorthand for `v.union(x, v.null())` |
| `v.commitTs()` | | commit timestamps |
| `v.email()` | | validated email string |

```ts
import { Infer, v, getDocumentSize, getConvexSize } from "convex/values";
export type Nested = Infer<typeof nestedObject>;
const bytes = getDocumentSize(doc);
```

Field names: non-empty, must not start with `$` or `_`.

### Index rules

- `.index(name, [field1, field2, ...])`. **`_creationTime` is implicitly appended as the last field.**
- **Max 16 fields per index** (including the implicit `_creationTime`); **max 32 indexes per table** (search + vector share that budget).
- No duplicate fields, no reserved (`_`-prefixed) fields.
- Convention: name the index after its fields (`by_channel_author`).

---

## 2. Functions

Source: <https://docs.convex.dev/functions/query-functions.md>, <https://docs.convex.dev/functions/mutation-functions.md>, <https://docs.convex.dev/functions/actions.md>, <https://docs.convex.dev/functions/internal-functions.md>, <https://docs.convex.dev/functions/validation.md>, <https://docs.convex.dev/database/writing-data.md>, <https://docs.convex.dev/api/interfaces/server.GenericDatabaseWriter.md>

```ts
import {
  query, mutation, action,
  internalQuery, internalMutation, internalAction,
} from "./_generated/server";
import { api, internal, components } from "./_generated/api";
import { v } from "convex/values";
```

```ts
export const send = mutation({
  args: { body: v.string(), channel: v.string() },
  returns: v.null(),               // OPTIONAL, but recommended
  handler: async (ctx, args) => {
    await ctx.db.insert("messages", args);
  },
});
```

`returns` is optional. When present it type-checks and runtime-validates the handler's return value; use `v.null()` for void.

### `ctx` contents

- `QueryCtx`: `db` (read), `storage`, `auth`
- `MutationCtx`: `db` (read/write), `storage`, `auth`, `scheduler`
- `ActionCtx`: `runQuery`, `runMutation`, `runAction`, `storage`, `auth`, `scheduler`, `vectorSearch` — **no `ctx.db`**

### Database API — **table name is now the first argument**

```ts
await ctx.db.get("messages", id);                 // Promise<Doc|null>
await ctx.db.insert("messages", { ... });         // Promise<Id<"messages">>
await ctx.db.patch("messages", id, { body });     // shallow merge; undefined removes a field
await ctx.db.replace("messages", id, { ... });    // full replace
await ctx.db.delete("messages", id);
ctx.db.query("messages");                         // QueryInitializer
ctx.db.system                                     // reader for _storage / _scheduled_functions
```

The old ID-only overloads (`ctx.db.patch(id, ...)`, `ctx.db.delete(id)`, `ctx.db.get(id)`) still exist but are marked **deprecated** in `GenericDatabaseWriter`.

### Query builder

```ts
const msgs = await ctx.db
  .query("messages")
  .withIndex("by_channel", (q) =>
    q.eq("channel", channel)
     .gt("_creationTime", Date.now() - 2 * 60_000)
     .lt("_creationTime", Date.now() - 60_000),
  )
  .order("desc")          // "asc" (default) | "desc"
  .take(10);              // .first() | .unique() | .collect() | .paginate(opts)
```

Index range expressions must follow the order: zero or more `.eq()` on consecutive index fields from the start, then an optional lower bound (`.gt`/`.gte`), then an optional upper bound (`.lt`/`.lte`). You must step through fields in index order.

- `.first()` → doc or `null`; `.unique()` → doc or `null`, **throws if >1 match**.
- `.filter(...)` exists but scans; prefer `.withIndex` or filtering in TS.
- `.collect()` is only safe for small result sets — docs: use indexes/pagination/`.take()` if you might touch **1000+ documents**.

### Text search

```ts
await ctx.db
  .query("messages")
  .withSearchIndex("search_body", (q) =>
    q.search("body", "hello hi").eq("channel", "#general"),
  )
  .take(10);
```
Limits: scans up to **1024** results from the search index; **16** filter fields per index; **16** search terms per query; **8** filter expressions per query.

### Pagination

Source: <https://docs.convex.dev/database/pagination.md>

```ts
import { paginationOptsValidator } from "convex/server";

export const list = query({
  args: { paginationOpts: paginationOptsValidator, channel: v.string() },
  handler: (ctx, args) =>
    ctx.db.query("messages")
      .withIndex("by_channel", (q) => q.eq("channel", args.channel))
      .order("desc")
      .paginate(args.paginationOpts),
});
```
`paginationOpts`: `{ numItems, cursor }` (cursor `null` for the first page; also `endCursor`, `id`, `maximumRowsRead` in the full type). Result: `{ page, isDone, continueCursor, splitCursor, pageStatus }`.

```ts
const { results, status, loadMore, isLoading } = usePaginatedQuery(
  api.messages.list, { channel }, { initialNumItems: 20 },
);
// status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted"
loadMore(20); // only meaningful when status === "CanLoadMore"
```
**Page sizes change reactively** — a page can grow or shrink as data changes; never assume `page.length === numItems`.

### Calling across function types

```ts
const data = await ctx.runQuery(internal.myFunctions.readData, { a });
await ctx.runMutation(internal.myMutations.writeData, { a });
await ctx.runAction(internal.myFunctions.doThing, {});
```
Only actions may call `runAction`. Use `internal.*` (never `api.*`) for anything scheduled or `ctx.run*`-ed. Use `FunctionReference<"query"|"mutation"|"action", "public"|"internal">` from `convex/server` when typing a passed-in reference.

### Auth in functions

Source: <https://docs.convex.dev/auth/functions-auth.md>

```ts
const identity = await ctx.auth.getUserIdentity();
if (identity === null) throw new Error("Unauthenticated");
const { tokenIdentifier, subject, issuer, name, email } = identity;
```
Guaranteed fields: `tokenIdentifier` (subject+issuer), `subject`, `issuer`. Optional/provider-dependent: `email`, `emailVerified`, `name`, `givenName`, `familyName`, `nickname`, `pictureUrl`, `updatedAt`, plus custom claims (dot-notation keys for custom JWTs, e.g. `identity["properties.email"]`).

---

## 3. Runtimes

Source: <https://docs.convex.dev/functions/runtimes.md>, <https://docs.convex.dev/functions/actions.md>, <https://docs.convex.dev/functions/bundling.md>

**Default (Convex/V8 isolate) runtime** — no cold starts, low-latency DB access. Available APIs:
- `fetch` (**actions only**), `Blob`, `Event`, `EventTarget`, `File`, `FormData`, `Headers`, `Request`, `Response`
- `TextEncoder`, `TextDecoder`, `atob`, `btoa`
- `ReadableStream` / `WritableStream` / `TransformStream`
- `crypto`, `CryptoKey`, `SubtleCrypto`
- `performance.now()`, `Performance`, `PerformanceEntry`/`Mark`/`Measure`
- `process.env`, `AsyncLocalStorage`, `AsyncResource`
- WebAssembly (`instantiate` / `Module` / `Instance`)
- **`setTimeout` is NOT available** — use `ctx.scheduler` for delays.

Determinism (queries/mutations): `Date.now()` is frozen at function start, `performance.now()` is constant within a query, `Math.random()` is seeded/reproducible.

**Node.js runtime** — opt in with `"use node";` as the first line of a file.
- Restricted to **actions only**. A `"use node"` file must not contain queries or mutations.
- **Files without `"use node"` must not import files with `"use node"`.** Utility files with no Convex functions may carry the directive.
- Node 20 by default; 20 / 22 / 24 selectable in `convex.json`.
- Argument limit drops to **5 MiB** (vs 16 MiB), memory 512 MB (vs 64 MB in the Convex runtime), max runtime 10 min (vs 30 min for Convex-runtime actions).

**Bundling** (esbuild over `convex/`): code bundle capped at **32 MiB**. Dynamic `import()`/`require()` is unsupported in the default runtime (breaks langchain, sharp, pdf-parse, tiktoken). External packages are **Node-runtime only**:

```json
// convex.json
{ "node": { "externalPackages": ["aws-sdk", "sharp"] } }
// or { "node": { "externalPackages": ["*"] } }
```
Source bundle + external packages must stay under **45 MB zipped / 240 MB unzipped**.

---

## 4. Limits

Source: <https://docs.convex.dev/production/state/limits.md>

**Per transaction (query/mutation)**
- Data read: **16 MiB** · Data written: **16 MiB**
- Documents scanned: **32,000** · Documents written: **16,000**
- Index ranges read: **4,096**

**Execution time**
- Query / mutation user code: **1 second**
- Convex-runtime action: **30 minutes**
- Node-runtime action: **10 minutes**

**Args / returns**
- Argument size: **16 MiB** (Node actions: **5 MiB**)
- Return value: **16 MiB** · HTTP action response: **20 MiB**

**Scheduled functions**
- Schedulable per mutation: **1,000**
- Per-job argument size: **4 MiB**; total scheduled args per mutation: **16 MiB**
- Outstanding scheduled functions: **1,000,000**

**Concurrency (by deployment class)** — S16: 64 concurrent actions/HTTP actions, 8 scheduled jobs · S256: 512 / 256 · D1024: 1,024 / 512 · D2048: 2,048 / 1,024.

**Documents & schema** — document size **1 MiB**; fields per document **1,024**; nesting depth **16**; array elements **8,192**; tables per deployment **10,000**; indexes per table **32**; fields per index **16**.

**Code/config** — deployment code **32 MiB**; env vars 1,000 per deployment, name ≤40 chars, value ≤8 KiB.

---

## 5. Scheduled functions

Source: <https://docs.convex.dev/scheduling/scheduled-functions.md>

```ts
const jobId: Id<"_scheduled_functions"> =
  await ctx.scheduler.runAfter(5000, internal.messages.destruct, { messageId });
await ctx.scheduler.runAt(new Date(Date.now() + 60_000), internal.x.y, {});
await ctx.scheduler.cancel(jobId);
```

Inspect via the system table:
```ts
await ctx.db.system.get("_scheduled_functions", jobId);
await ctx.db.system.query("_scheduled_functions").collect();
```
`state.kind`: `Pending` | `InProgress` | `Success` | `Failed` | `Canceled`.

**Guarantees**
- Scheduling from a **mutation is transactional**: if the mutation commits, the job is guaranteed scheduled; if it rolls back, nothing is scheduled.
- Scheduling from an **action is not atomic** — the schedule sticks regardless of whether the action later fails.
- Scheduled **mutations execute exactly once**; scheduled **actions execute at most once** (no automatic retry).
- `cancel` prevents a not-yet-started job from running; an already-running job continues, but anything *it* schedules will not run.
- Records are retained for **7 days** after completion.
- **Auth is not propagated** into scheduled functions — pass user identity as an argument.

---

## 6. Cron jobs

Source: <https://docs.convex.dev/scheduling/cron-jobs.md>

```ts
// convex/crons.ts
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("clear presence", { minutes: 1 }, internal.presence.clear, {});
crons.cron("every minute", "* * * * *", internal.x.tick, {});
crons.hourly("rollup", { minuteUTC: 23 }, internal.stats.rollup, {});
crons.daily("digest", { hourUTC: 17, minuteUTC: 23 }, internal.email.digest, { list: "all" });
crons.weekly("report", { dayOfWeek: "monday", hourUTC: 9 }, internal.x.report, {});
crons.monthly("invoice", { day: 1, hourUTC: 16 }, internal.billing.run, {});

export default crons;
```
Signature is `(name, schedule, functionReference, args?)`. `interval` accepts `{ seconds | minutes | hours }`. All times are **UTC**. At most one run of a given cron executes at a time; overlapping runs are skipped rather than queued. Avoid `minuteUTC: 0` — omit `minuteUTC` to let Convex spread load.

---

## 7. Workpool (`@convex-dev/workpool` 0.4.11)

Source: <https://github.com/get-convex/workpool> (README), <https://www.convex.dev/components/workpool>

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import workpool from "@convex-dev/workpool/convex.config.js";

const app = defineApp();
app.use(workpool, { name: "emailWorkpool" });
app.use(workpool, { name: "scrapeWorkpool" });
export default app;
```

```ts
import { Workpool, NonRetryableError } from "@convex-dev/workpool";
import { components } from "./_generated/api";

const pool = new Workpool(components.emailWorkpool, {
  maxParallelism: 10,
  retryActionsByDefault: true,
  defaultRetryBehavior: { maxAttempts: 3, initialBackoffMs: 1000, base: 2 },
  statusTtl: 24 * 60 * 60 * 1000,  // default 1 day; POSITIVE_INFINITY to keep forever
  logLevel: "INFO",                // "DEBUG" for verbose
});
```

```ts
const workId = await pool.enqueueAction(ctx, internal.email.send, { to }, {
  retry: true,                       // true | false | { maxAttempts, initialBackoffMs, base }
  onComplete: internal.email.onSent, // a MUTATION
  context: { emailType: "welcome", userId },
  runAfter: 5000,                    // or runAt: <timestamp>
});
await pool.enqueueMutation(ctx, internal.db.write, args, opts);
await pool.enqueueActionBatch(ctx, internal.email.send, [argsA, argsB]);

const status = await pool.status(workId);
// { kind: "pending"|"running", previousAttempts } | { kind: "finished" }
await pool.cancel(ctx, workId);
await pool.cancelAll(ctx);
```

`onComplete` runs **as a separate mutation, in its own transaction**:
```ts
export const onSent = pool.defineOnComplete<DataModel>({
  context: v.object({ emailType: v.string(), userId: v.id("users") }),
  handler: async (ctx, { workId, context, result }) => {
    // result: { kind: "success"; returnValue }
    //       | { kind: "failed"; error }
    //       | { kind: "canceled" }
  },
});
```
Helpers: `vWorkIdValidator`, `vOnCompleteValidator`. Throw `NonRetryableError` to abort remaining retries.

**Parallelism guidance**: keep the *sum* of `maxParallelism` across all pools/workflows **under 100 on Pro, 20 on the free tier**. Runtime override: `ctx.runMutation(components.myWorkpool.config.update, { maxParallelism: 20 })`. Retry backoff = `initialBackoffMs * base^(retry-1)` with jitter. **Enqueued actions must be idempotent** (e.g. pass a stable idempotency key to external APIs) since retries can re-run them.

---

## 8. Workflow (`@convex-dev/workflow` 0.4.6)

Source: <https://github.com/get-convex/workflow> (README)

Durable, long-lived multi-step orchestration built on Workpool. Each `step.*` result is journaled, so the handler can be replayed across restarts.

```ts
// convex/convex.config.ts
import workflow from "@convex-dev/workflow/convex.config.js";
app.use(workflow);

// convex/index.ts
import { WorkflowManager } from "@convex-dev/workflow";
import { components } from "./_generated/api";

export const workflow = new WorkflowManager(components.workflow, {
  workpoolOptions: {
    maxParallelism: 10,
    retryActionsByDefault: false,
    defaultRetryBehavior: { maxAttempts: 3, initialBackoffMs: 100, base: 2 },
  },
});
```

```ts
export const exampleWorkflow = workflow
  .define({
    args: { userId: v.id("users") },
    returns: v.string(),        // always annotate to avoid TS type cycles
  })
  .handler(async (step, args): Promise<string> => {
    const user = await step.runQuery(internal.users.get, { id: args.userId },
      { name: "load user", inline: true });          // inline: share the workflow txn
    const res = await step.runAction(internal.ai.summarize, { user },
      { retry: { maxAttempts: 2, initialBackoffMs: 100, base: 2 }, runAfter: 0 });
    await step.sleep(24 * 60 * 60 * 1000, { name: "wait one day" });
    const evt = await step.awaitEvent({ name: "approved", validator: v.string() });
    await step.runWorkflow(internal.example.child, {}, { runAfter: 5000 });
    return res;
  });
```

Lifecycle helpers are **top-level imports**, not manager methods:
```ts
import { start, getStatus, cancel, cleanup, restart } from "@convex-dev/workflow";

const id = await start(ctx, internal.example.exampleWorkflow, args, {
  onComplete: internal.example.handleCompletion,
  context: { metadata: "..." },
});
const status = await getStatus(ctx, components.workflow, id);
await cancel(ctx, components.workflow, id);
await cleanup(ctx, components.workflow, id);
await restart(ctx, components.workflow, id, { from: 2 /* or "stepName" or a fn ref */, startAsync: true });
```

**Determinism**: the handler body must be deterministic. `fetch`, environment variables and `crypto` are **restricted**; `console`, `Math.random()` (seeded PRNG) and `Date` are **patched**. All side effects must go through `step.*`.

**Limits**: journal ≈ **1 MB** of data per workflow run, **8 MiB** hard cap. Step args are re-validated on replay (`{ unstableArgs: true }` opts out). Queries/mutations retry automatically on system errors with exactly-once semantics; **actions need explicit `retry`**.

**Workflow vs Workpool**: Workflow for long-lived, ordered, multi-step processes with sleeps/events/conditionals. Workpool for fan-out of independent tasks with bounded concurrency.

---

## 9. Next.js integration

Source: <https://docs.convex.dev/quickstart/nextjs.md>, <https://docs.convex.dev/client/nextjs/app-router/server-rendering.md>, <https://docs.convex.dev/client/react/overview.md>, <https://docs.convex.dev/client/react/optimistic-updates.md>, <https://docs.convex.dev/api/modules/nextjs.md>, <https://docs.convex.dev/client/javascript/overview.md>, <https://docs.convex.dev/cli/local-deployments.md>

```tsx
// app/ConvexClientProvider.tsx
"use client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
export function ConvexClientProvider({ children }: { children: React.ReactNode }) {
  return <ConvexProvider client={convex}>{children}</ConvexProvider>;
}
```

Client hooks (`convex/react`): `useQuery(fn, args | "skip")` returns `undefined` while loading; `useMutation`, `useAction`, `usePaginatedQuery`, `useConvex`, `useConvexAuth`, and `<Authenticated>` / `<Unauthenticated>` / `<AuthLoading>`.

**Server rendering** (`convex/nextjs`):
```tsx
// server component
import { preloadQuery, fetchQuery, fetchMutation, fetchAction } from "convex/nextjs";
const preloadedTasks = await preloadQuery(api.tasks.list, { list: "default" }, { token });
const tasks       = await fetchQuery(api.tasks.list, { list: "default" }, { token });
await fetchMutation(api.tasks.create, { text }, { token });
await fetchAction(api.tasks.sync, {}, { token });
```
```tsx
// client component
"use client";
import { usePreloadedQuery, type Preloaded } from "convex/react";
export function Tasks(props: { preloadedTasks: Preloaded<typeof api.tasks.list> }) {
  const tasks = usePreloadedQuery(props.preloadedTasks);
}
```
`preloadedQueryResult(preloaded)` (from `convex/nextjs`) reads the value server-side without a hook. `NextjsOptions` = `{ token?, url?, adminToken?, skipConvexDeploymentUrlCheck? }`. **`preloadQuery` uses `cache: "no-store"`, so the server component is not statically renderable.**

Custom auth provider:
```tsx
<ConvexProviderWithAuth client={convex} useAuth={useMyAuth}>
```
`useAuth` must return `{ isLoading: boolean, isAuthenticated: boolean, fetchAccessToken: ({ forceRefreshToken }: { forceRefreshToken: boolean }) => Promise<string | null> }`. Clerk: `ConvexProviderWithClerk` from `convex/react-clerk`. Server side:
```ts
// convex/auth.config.ts
export default { providers: [{ domain: "https://issuer.url", applicationID: "aud-value" }] } satisfies AuthConfig;
```
`applicationID` must equal the JWT `aud`; `domain` must equal `iss` exactly.

Optimistic updates:
```ts
const send = useMutation(api.messages.send).withOptimisticUpdate((localStore, args) => {
  const existing = localStore.getQuery(api.messages.list, { channel: args.channel });
  if (existing !== undefined) {
    localStore.setQuery(api.messages.list, { channel: args.channel }, [...existing, newMessage]);
  }
});
```
`localStore`: `getQuery`, `setQuery`, `getAllQueries`. Always construct **new** objects/arrays.

HTTP clients: `import { ConvexHttpClient, ConvexClient } from "convex/browser"`. `new ConvexHttpClient(url)` with `.query/.mutation/.action` and `.setAuth(token)`; `ConvexClient` adds `onUpdate(fn, args, cb)` subscriptions.

Env / CLI: `NEXT_PUBLIC_CONVEX_URL`, `CONVEX_DEPLOYMENT` in `.env.local`; `npx convex dev` (codegen + push), `convex.json` for project config. Local/anonymous dev: `npx convex deployment select local` (back with `select dev`) — runs the backend as a subprocess of `npx convex dev`, works **without an account** (`npx convex login` later to link). Caveats: no public URL (no inbound webhooks), Node actions get unrestricted filesystem access, Safari/Brave block localhost, logs reset on restart, not for production.

### Testing (`convex-test` 0.0.56)

```bash
npm i -D convex-test vitest @edge-runtime/vm
```
```ts
// vitest.config.ts -> test: { environment: "edge-runtime" }
import { convexTest } from "convex-test";
import schema from "./schema";
const modules = import.meta.glob("./**/*.ts");
// custom convex dir: import.meta.glob("./**/!(*.*.*)*.*s")

const t = convexTest(schema, modules);
await t.mutation(api.tasks.create, { text: "x" });
await t.query(api.tasks.list, {});
await t.action(api.x.doIt, { a: 1 });
await t.run(async (ctx) => ctx.db.insert("tasks", { text: "Eat breakfast" }));
const asSarah = t.withIdentity({ name: "Sarah" });
await t.finishInProgressScheduledFunctions();
await t.finishAllScheduledFunctions(vi.runAllTimers);
```
Components must be registered before use, e.g. `import agentTest from "@convex-dev/agent/test"; agentTest.register(t);` (or register schema+modules manually). `convex-test` is a **mock**: no size/time-limit enforcement, simplified text search, no cron support, Edge Runtime rather than the real Convex runtime. There is no `@convex-dev/test` package.

---

## 10. Auth: Better Auth component vs Convex Auth

Source: <https://labs.convex.dev/better-auth/framework-guides/next>, <https://docs.convex.dev/auth/overview.md>, <https://docs.convex.dev/auth/convex-auth.md>

**Convex Auth (`@convex-dev/auth` 0.0.95)** is still labelled **beta** in the docs ("isn't complete and may change in backward-incompatible ways", fewer features than third-party integrations; Next.js support "under active development"). The official auth overview page lists **Clerk, WorkOS AuthKit, Auth0, custom OIDC, and Convex Auth** — it does **not** mention Better Auth, so there is currently **no docs.convex.dev page recommending Better Auth over Convex Auth**; the Better Auth component lives at labs.convex.dev.

**Better Auth component (`@convex-dev/better-auth` 0.12.5)** — requires `convex >= 1.25.0`.

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import betterAuth from "@convex-dev/better-auth/convex.config";
const app = defineApp();
app.use(betterAuth);
export default app;

// convex/auth.config.ts
import { getAuthConfigProvider } from "@convex-dev/better-auth/auth-config";
export default { providers: [getAuthConfigProvider()] } satisfies AuthConfig;

// convex/auth.ts
import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { betterAuth } from "better-auth/minimal";
import { components } from "./_generated/api";
import { DataModel } from "./_generated/dataModel";
import authConfig from "./auth.config";

export const authComponent = createClient<DataModel>(components.betterAuth);

export const createAuth = (ctx: GenericCtx<DataModel>) =>
  betterAuth({
    baseURL: process.env.SITE_URL!,
    database: authComponent.adapter(ctx),
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    plugins: [convex({ authConfig })],
  });

export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => authComponent.getAuthUser(ctx),
});

// convex/http.ts
import { httpRouter } from "convex/server";
import { authComponent, createAuth } from "./auth";
const http = httpRouter();
authComponent.registerRoutes(http, createAuth);
export default http;
```

```ts
// lib/auth-client.ts
import { createAuthClient } from "better-auth/react";
import { convexClient } from "@convex-dev/better-auth/client/plugins";
export const authClient = createAuthClient({ plugins: [convexClient()] });

// lib/auth-server.ts
import { convexBetterAuthNextJs } from "@convex-dev/better-auth/nextjs";
export const {
  handler, preloadAuthQuery, isAuthenticated, getToken,
  fetchAuthQuery, fetchAuthMutation, fetchAuthAction,
} = convexBetterAuthNextJs({
  convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL!,
  convexSiteUrl: process.env.NEXT_PUBLIC_CONVEX_SITE_URL!,
  basePath: "/api/auth",
});

// app/api/auth/[...all]/route.ts
export const { GET, POST } = handler;
```

```tsx
// app/ConvexClientProvider.tsx
"use client";
import { ConvexReactClient } from "convex/react";
import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import { authClient } from "@/lib/auth-client";
const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
export function ConvexClientProvider({ children, initialToken }:
  { children: React.ReactNode; initialToken?: string | null }) {
  return (
    <ConvexBetterAuthProvider client={convex} authClient={authClient} initialToken={initialToken}>
      {children}
    </ConvexBetterAuthProvider>
  );
}
```

Env:
```
CONVEX_DEPLOYMENT=dev:adjective-animal-123
NEXT_PUBLIC_CONVEX_URL=https://adjective-animal-123.convex.cloud
NEXT_PUBLIC_CONVEX_SITE_URL=https://adjective-animal-123.convex.site
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```
```bash
npx convex env set BETTER_AUTH_SECRET=$(openssl rand -base64 32)
npx convex env set SITE_URL http://localhost:3000
```

Inside Convex functions, `ctx.auth.getUserIdentity()` returns the standard `UserIdentity` (`subject` = Better Auth user id, `issuer` = your Convex site URL, plus `email`/`name` claims). `authComponent.getAuthUser(ctx)` returns the full Better Auth user document from the component's tables. Server-side calls need the token: `await fetchQuery(api.x.y, args, { token: await getToken() })`, or use the wrapped `fetchAuthQuery` / `preloadAuthQuery`.

The component runs in the **default Convex runtime** — no `"use node"` needed. It works on local/anonymous deployments, but auth callbacks from external OAuth providers need a public `.convex.site` URL, so cloud dev is easier for social sign-in.

> **Version caveat (important for this repo):** `@convex-dev/better-auth@0.12.5` declares `peerDependencies: { "better-auth": ">=1.6.11 <1.7.0" }`, and the official Next.js guide pins `npm install better-auth@~1.6.15`. **`better-auth@1.7.x` is not yet supported** by any published (`latest`/`alpha`/`next`) version of the component. If this project is on better-auth 1.7, expect peer-dep failures and adapter breakage — pin to `~1.6.15` until the component ships 1.7 support.

---

## 11. File storage (brief)

Source: <https://docs.convex.dev/file-storage/upload-files.md>, <https://docs.convex.dev/file-storage/store-files.md>

```ts
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => ctx.storage.generateUploadUrl(), // expires in 1 hour
});
// in an HTTP action:
const storageId = await ctx.storage.store(await request.blob());
// elsewhere:
const url  = await ctx.storage.getUrl(storageId);
const meta = await ctx.db.system.get("_storage", storageId);
await ctx.storage.delete(storageId);
```
Upload-URL POSTs have no size cap but a **2-minute timeout**; HTTP-action request bodies are capped at **20 MB**. Prefer file storage over `v.bytes()` — bytes values are limited to **< 1 MiB** and count against the 1 MiB document size.

---

## Discrepancies / gotchas vs. common assumptions

1. **`ctx.db` now takes the table name first.** `ctx.db.get("messages", id)`, `ctx.db.patch("messages", id, {...})`, `ctx.db.replace("messages", id, {...})`, `ctx.db.delete("messages", id)`. The classic ID-only overloads are explicitly **deprecated** in `GenericDatabaseWriter`. Most training-data snippets use the deprecated form.
2. **`returns` is optional, not required** — but recommended. It runtime-validates the return value, so adding it to an existing function can start throwing.
3. **Workflow API is builder-style and uses free functions.** It is `workflow.define({ args, returns }).handler(async (step, args) => ...)` — *not* `workflow.define({ args, handler })`. Lifecycle is `import { start, getStatus, cancel, cleanup, restart } from "@convex-dev/workflow"` taking `(ctx, components.workflow, id)` — *not* `workflow.start(...)` methods.
4. **Workpool `onComplete` is a mutation running in its own transaction**, separate from the enqueued work. It does not roll back with the job. `pool.status(id)` returns coarse `pending`/`running`/`finished` — it does not carry the return value; get that from `onComplete`. Status is garbage-collected after `statusTtl` (default **1 day**).
5. **`enqueueQuery` is not part of the documented Workpool API.** Only `enqueueAction`, `enqueueMutation` and the `*Batch` variants appear in the README.
6. **Total parallelism is a global budget**: keep the sum of `maxParallelism` across every workpool and workflow under **100 (Pro) / 20 (free)**, not per pool.
7. **Scheduler semantics differ by caller.** From a mutation it's transactional and scheduled *mutations* run exactly once; scheduled **actions run at most once with no automatic retry** — that's why Workpool/Workflow exist. Scheduling from an action is not atomic. Auth is not propagated into scheduled functions.
8. **`setTimeout` does not exist in the default Convex runtime.** `fetch` exists but only in actions. `process.env` *is* available in the default runtime.
9. **`"use node"` is actions-only and import-directional**: a non-node file importing a `"use node"` file is an error, and node-runtime actions take max **5 MiB** args instead of 16 MiB.
10. **Action time limits are asymmetric**: Convex-runtime actions get **30 minutes**, Node-runtime actions **10 minutes**. The commonly cited "10 min for all actions" is only true for Node.
11. **Query/mutation user code gets 1 second.** Long loops fail long before the 32,000-document scan limit.
12. **`.collect()` has no hard cap of its own** — it fails via the 32,000-scanned-documents / 16 MiB-read transaction limits. Docs say switch to pagination/`take` above ~1,000 documents.
13. **Pagination page sizes are not stable.** Pages grow and shrink reactively; `numItems` is a request, not a guarantee. `usePaginatedQuery` status is a 4-value union, not a boolean.
14. **Index budget is shared**: 32 indexes per table covers regular + search + vector indexes, and the 16-field-per-index cap **includes the implicit `_creationTime`**.
15. **New validators exist that predate most training data**: `v.nullable()`, `v.commitTs()`, `v.email()`, plus `getDocumentSize` / `getConvexSize` from `convex/values`.
16. **Better Auth is not on docs.convex.dev.** It lives at labs.convex.dev (the old `convex-better-auth.netlify.app` 301s there). The official auth overview still lists Convex Auth (beta) alongside Clerk/AuthKit/Auth0 and makes no Better Auth recommendation.
17. **`@convex-dev/better-auth@0.12.5` requires `better-auth >=1.6.11 <1.7.0`.** This repo's `better-auth@1.7.x` is outside the supported peer range; the guide pins `better-auth@~1.6.15`. No published component version (including `alpha`/`next` tags, which are *older* than `latest`) supports 1.7.
18. **Better Auth Next.js wiring is now generated by `convexBetterAuthNextJs()`**, which returns `{ handler, preloadAuthQuery, isAuthenticated, getToken, fetchAuthQuery, fetchAuthMutation, fetchAuthAction }`, and the Convex-side config uses `betterAuth` from **`better-auth/minimal`** with a `convex({ authConfig })` plugin. Older hand-rolled `getToken(createAuth)` snippets are out of date.
19. **`preloadQuery` disables static rendering** (`cache: "no-store"`), so a page using it is always dynamic.
20. **Cron `crons.hourly/daily/weekly/monthly` take named UTC fields** (`hourUTC`, `minuteUTC`, `dayOfWeek`, `day`), all UTC; overlapping runs are **skipped**, not queued.
21. **`convex-test` is a mock** in Edge Runtime — no limit enforcement, no crons, approximate text search — and components need explicit registration (`agentTest.register(t)`). There is no `@convex-dev/test` package.
22. **External npm packages (`convex.json` → `node.externalPackages`) only work in the Node runtime**, and dynamic `import()`/`require()` is unsupported in the default runtime (langchain, sharp, pdf-parse, tiktoken all break there).

---

## 12. Convex Auth (`@convex-dev/auth`)

Verified against the live docs at <https://labs.convex.dev/auth> on 2026-09-08, cross-checked against the installed `@convex-dev/auth@0.0.95` d.ts/dist in `node_modules`. Status per the docs: **beta / "early preview"** (<https://labs.convex.dev/auth>, <https://labs.convex.dev/auth/faq>).

### 12.1 Install + setup CLI

Source: <https://labs.convex.dev/auth/setup>, <https://labs.convex.dev/auth/setup/manual>, <https://labs.convex.dev/auth/production>

```bash
npm install @convex-dev/auth @auth/core@0.41.1   # docs pin @auth/core exactly
npx @convex-dev/auth                              # dev deployment
npx @convex-dev/auth --prod                       # production deployment
```

The CLI is **interactive** — it prompts for each value and asks for confirmation before overwriting an existing env var (verified in `dist/bin.cjs`; flags: `--variables <json>`, `--web-server-url <url>`, `--skip-git-check`, plus the standard `--prod` / `--url` / `--deployment-name` / `--preview-name` / `--admin-key`). It warns if you are not in a clean Git checkout. Steps it runs:

1. `SITE_URL` → `npx convex env set SITE_URL …` (default `http://localhost:3000` for Next.js, `http://localhost:5173` for Vite; skipped for Expo).
2. Generates an RS256 keypair with `jose` and sets `JWT_PRIVATE_KEY` (PKCS8, newlines replaced by spaces) and `JWKS`.
3. Patches `convex/tsconfig.json` → `"moduleResolution": "Bundler"`, `"skipLibCheck": true`.
4. Writes `convex/auth.config.ts`, `convex/auth.ts`, `convex/http.ts`.

It does **not** touch `convex/schema.ts` or your frontend ("You're all set. Continue by configuring your schema and frontend.").

Manual equivalent (<https://labs.convex.dev/auth/setup/manual>):

```bash
npx convex env set SITE_URL http://localhost:5173
node generateKeys.mjs    # then: npx convex env set JWT_PRIVATE_KEY "…" ; npx convex env set JWKS '…'
```

```js
// generateKeys.mjs  (verbatim from the manual-setup page)
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";

const keys = await generateKeyPair("RS256", { extractable: true });
const privateKey = await exportPKCS8(keys.privateKey);
const publicKey = await exportJWK(keys.publicKey);
const jwks = JSON.stringify({ keys: [{ use: "sig", ...publicKey }] });

process.stdout.write(`JWT_PRIVATE_KEY="${privateKey.trimEnd().replace(/\n/g, " ")}"`);
process.stdout.write("\n");
process.stdout.write(`JWKS=${jwks}`);
process.stdout.write("\n");
```

### 12.2 Schema — `authTables`

Source: <https://labs.convex.dev/auth/setup>, <https://labs.convex.dev/auth/setup/schema>, <https://labs.convex.dev/auth/api_reference/server>

```ts
// convex/schema.ts
import { defineSchema } from "convex/server";
import { authTables } from "@convex-dev/auth/server";

const schema = defineSchema({
  ...authTables,
  // Your other tables...
});
export default schema;
```

Seven tables: **`users`, `authSessions`, `authAccounts`, `authRefreshTokens`, `authVerificationCodes`, `authVerifiers`, `authRateLimits`.** Shapes and indexes (from the installed `dist/server/implementation/types.d.ts`; the docs page shows only the `users` table):

| table | fields | indexes |
|---|---|---|
| `users` | all optional: `name`, `image`, `email`, `emailVerificationTime`, `phone`, `phoneVerificationTime`, `isAnonymous` | `email`, `phone` |
| `authSessions` | `userId`, `expirationTime` | `userId` |
| `authAccounts` | `userId`, `provider`, `providerAccountId`, `secret?`, `emailVerified?`, `phoneVerified?` | `userIdAndProvider`, `providerAndAccountId` |
| `authRefreshTokens` | `sessionId`, `expirationTime`, `firstUsedTime?`, `parentRefreshTokenId?` | `sessionId`, `sessionIdAndParentRefreshTokenId` |
| `authVerificationCodes` | `accountId`, `provider`, `code`, `expirationTime`, `verifier?`, `emailVerified?`, `phoneVerified?` | `accountId`, `code` |
| `authVerifiers` | `sessionId?`, `signature?` (PKCE) | `signature` |
| `authRateLimits` | `identifier`, `lastAttemptTime`, `attemptsLeft` | `identifier` |

Extending `users` — inline the table instead of spreading it (<https://labs.convex.dev/auth/setup/schema>):

```ts
const schema = defineSchema({
  ...authTables,
  users: defineTable({
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    // + your own fields
  }).index("email", ["email"]),
});
```
The page says you may add optional fields and indexes freely; **required** fields are only safe if every auth method supplies them at sign-up. Customizing `authSessions` is "not recommended".

### 12.3 `convexAuth` / http / auth.config

Source: <https://labs.convex.dev/auth/setup/manual>, <https://labs.convex.dev/auth/api_reference/server>

```ts
function convexAuth(config: ConvexAuthConfig): {
  auth: AuthHelper;
  signIn: SignInAction;
  signOut: SignOutAction;
  store: StoreMutation;
  isAuthenticated: IsAuthenticatedQuery;
};
```

```ts
// convex/auth.ts
import { convexAuth } from "@convex-dev/auth/server";
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [],
});

// convex/auth.config.ts
export default {
  providers: [{ domain: process.env.CONVEX_SITE_URL, applicationID: "convex" }],
};

// convex/http.ts
import { httpRouter } from "convex/server";
import { auth } from "./auth";
const http = httpRouter();
auth.addHttpRoutes(http);
export default http;
```
All five exports must be public — the client calls `signIn`/`signOut` (actions), `store` (mutation) and `isAuthenticated` (query) by name.

### 12.4 Password (and Anonymous) providers

Source: <https://labs.convex.dev/auth/config/passwords>, <https://labs.convex.dev/auth/api_reference/providers/Anonymous>

```ts
import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Password],
});
```

Client flow — `flow` is a **form/param field**, not a separate provider:

```tsx
const { signIn } = useAuthActions();
void signIn("password", { email, password, flow: "signUp" }); // or "signIn"
// equivalently: pass a FormData with name="email" / name="password" / hidden name="flow"
```

Custom profile fields and password rules:

```ts
export default Password<DataModel>({
  profile(params, ctx) {
    return {
      email: params.email as string,
      name: params.name as string,
      role: params.role as string,
    };
  },
  validatePasswordRequirements: (password: string) => {
    if (password.length < 8 || !/\d/.test(password) || !/[a-z]/.test(password) || !/[A-Z]/.test(password)) {
      throw new ConvexError("Invalid password.");
    }
  },
});
```
`profile()` doubles as input validation (the docs use `zod` + `ConvexError` for email). Optional email flows: `Password({ reset: ResendOTPPasswordReset })` and `Password({ verify: ResendOTP })` — both take an Email provider config.

```ts
import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
convexAuth({ providers: [Anonymous] });          // AnonymousConfig: { id?, profile?(params, ctx) }
// sets users.isAnonymous; sign in with signIn("anonymous")
```

### 12.5 Next.js integration

Source: <https://labs.convex.dev/auth/setup> (Next.js tab, mirrored at `docs/pages/setup.mdx`), <https://labs.convex.dev/auth/authz/nextjs>, <https://labs.convex.dev/auth/api_reference/nextjs>, <https://labs.convex.dev/auth/api_reference/nextjs/server>

```tsx
// app/layout.tsx  (server component)
import { ConvexAuthNextjsServerProvider } from "@convex-dev/auth/nextjs/server";

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <ConvexAuthNextjsServerProvider>
      <html lang="en"><body>{children}</body></html>
    </ConvexAuthNextjsServerProvider>
  );
}
```

```tsx
// app/ConvexClientProvider.tsx
"use client";
import { ConvexAuthNextjsProvider } from "@convex-dev/auth/nextjs";
import { ConvexReactClient } from "convex/react";
import { ReactNode } from "react";

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  return <ConvexAuthNextjsProvider client={convex}>{children}</ConvexAuthNextjsProvider>;
}
```

```ts
// middleware.ts
import {
  convexAuthNextjsMiddleware,
  createRouteMatcher,
  nextjsMiddlewareRedirect,
} from "@convex-dev/auth/nextjs/server";

const isSignInPage = createRouteMatcher(["/signin"]);
const isProtectedRoute = createRouteMatcher(["/product(.*)"]);

export default convexAuthNextjsMiddleware(async (request, { convexAuth }) => {
  if (isSignInPage(request) && (await convexAuth.isAuthenticated())) {
    return nextjsMiddlewareRedirect(request, "/product");
  }
  if (isProtectedRoute(request) && !(await convexAuth.isAuthenticated())) {
    return nextjsMiddlewareRedirect(request, "/signin");
  }
});

export const config = { matcher: ["/((?!.*\\..*|_next).*)", "/", "/(api|trpc)(.*)"] };
```

Signatures (<https://labs.convex.dev/auth/api_reference/nextjs/server>):
```ts
ConvexAuthNextjsServerProvider(props: {
  apiRoute?: string;                 // default "/api/auth"
  storage?: "localStorage" | "inMemory";
  storageNamespace?: string;         // defaults to NEXT_PUBLIC_CONVEX_URL
  shouldHandleCode?: boolean | (() => boolean);
  verbose?: boolean;
  children: ReactNode;
}): Promise<Element>;

ConvexAuthNextjsProvider(props: { client: ConvexReactClient; children: ReactNode }): Element;

convexAuthNextjsMiddleware(
  handler?: (request, ctx) => NextMiddlewareResult | Promise<NextMiddlewareResult>,
  options?: {
    convexUrl?: string;
    apiRoute?: string;
    cookieConfig?: { maxAge?: number };
    verbose?: boolean;
    shouldHandleCode?: boolean | ((request) => boolean);
  },
): NextMiddleware;

convexAuthNextjsToken(): Promise<string | undefined>;
isAuthenticatedNextjs(options?: { convexUrl?: string }): Promise<boolean>;
createRouteMatcher(routes: RouteMatcherParam): (req: NextRequest) => boolean;
nextjsMiddlewareRedirect(request: NextRequest, route: string): NextResponse;
```

Server-side data with the token (<https://labs.convex.dev/auth/authz/nextjs>):

```tsx
import { convexAuthNextjsToken } from "@convex-dev/auth/nextjs/server";
import { preloadQuery, fetchQuery, fetchMutation } from "convex/nextjs";

const preloaded = await preloadQuery(api.tasks.list, { list: "default" },
  { token: await convexAuthNextjsToken() });

await fetchMutation(api.tasks.create, { text }, { token: await convexAuthNextjsToken() }); // in a Server Action
```
The docs warn: only queries are safe from Server Components / GET Route Handlers — "you **must not** perform any side-effects from the Next.js server on GET requests" (CSRF).

Client hooks/components (<https://labs.convex.dev/auth/api_reference/react>, <https://labs.convex.dev/auth/authz>):

```ts
useAuthActions(): {
  signIn(provider: string, params?: FormData | Record<string, Value>):
    Promise<{ signingIn: boolean; redirect?: URL }>;
  signOut(): Promise<void>;
};
useAuthToken(): string | null;   // for hand-rolled fetch to .convex.site HTTP actions
```
```tsx
import { Authenticated, Unauthenticated, AuthLoading } from "convex/react"; // plus useConvexAuth()
```
`ConvexAuthProvider` (`@convex-dev/auth/react`) is the non-Next.js equivalent: `{ client, storage?, storageNamespace?, replaceURL?, shouldHandleCode?, children }`.

**Next 16 `middleware.ts` → `proxy.ts`:** the Convex Auth docs still say `middleware.ts` and only `middleware.ts` — they have **not** been updated for Next 16. Next 16 deprecates the `middleware` file convention and renames it to `proxy` (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`, `v16.0.0 | Middleware is deprecated and renamed to Proxy. Proxy defaults to the Node.js runtime`). `proxy.ts` accepts "a single function, either as a default export or named `proxy`", so `export default convexAuthNextjsMiddleware(...)` in `proxy.ts` is the Next-16 form; codemod: `npx @next/codemod@canary middleware-to-proxy .`. Nothing in `@convex-dev/auth@0.0.95` references the file name, so the rename is purely a Next-side concern.

### 12.6 Server-side helpers in Convex functions

Source: <https://labs.convex.dev/auth/authz>, <https://labs.convex.dev/auth/api_reference/server>

```ts
getAuthUserId(ctx: { auth: Auth }): Promise<Id<"users"> | null>;
getAuthSessionId(ctx: { auth: Auth }): Promise<Id<"authSessions"> | null>;
```

```ts
import { getAuthUserId } from "@convex-dev/auth/server";
export const currentUser = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    return await ctx.db.get(userId);   // in this repo's Convex: ctx.db.get("users", userId)
  },
});
```

`ctx.auth.getUserIdentity()` returns the normal `UserIdentity`, but **`subject` is `` `${userId}|${sessionId}` ``** — the JWT `sub` claim is built as `args.userId + TOKEN_SUB_CLAIM_DIVIDER + args.sessionId` with `TOKEN_SUB_CLAIM_DIVIDER = "|"` (`dist/server/implementation/tokens.js`, `utils.js`), and both helpers just `split("|")` it. `issuer` is `CONVEX_SITE_URL`, `applicationID`/aud is `"convex"`. Never use `identity.subject` directly as a user id.

Other server exports (<https://labs.convex.dev/auth/api_reference/server>): `createAccount`, `retrieveAccount`, `modifyAccountCredentials`, `invalidateSessions({ userId, except? })`, `signInViaProvider`.

### 12.7 Config: sessions, JWT, callbacks

Source: <https://labs.convex.dev/auth/api_reference/server>, <https://labs.convex.dev/auth/advanced>, <https://labs.convex.dev/auth/security>

```ts
interface ConvexAuthConfig {
  providers: AuthProviderConfig[];
  theme?: Theme;
  session?: {
    totalDurationMs?: number;      // default 30 days
    inactiveDurationMs?: number;   // default 30 days
  };
  jwt?: {
    durationMs?: number;           // default 1 hour
    customClaims?(ctx, args): Promise<Record<string, JSONValue>>;
  };
  signIn?: { maxFailedAttempsPerHour?: number }; // default 10 — note the library's typo "Attemps"
  callbacks?: {
    redirect?(params: { redirectTo: string }): Promise<string>;
    createOrUpdateUser?(ctx: MutationCtx, args): Promise<Id<"users">>;
    afterUserCreatedOrUpdated?(ctx: MutationCtx, args): Promise<void>;
    beforeSessionCreation?(ctx: MutationCtx, args): Promise<void>;
  };
}
```

```ts
convexAuth({
  providers: [Password],
  callbacks: {
    // full control over the users row; args.type is
    // "oauth" | "email" | "phone" | "credentials" | "verification",
    // plus args.provider, args.existingUserId, args.profile
    async createOrUpdateUser(ctx, args) {
      if (args.existingUserId) return args.existingUserId;
      return ctx.db.insert("users", { /* ... */ });
    },
    // preferred hook when you only need a side-effect
    async afterUserCreatedOrUpdated(ctx, { userId }) {
      await ctx.db.insert("someTable", { userId, data: "some data" });
    },
  },
  jwt: {
    customClaims: async (ctx, { userId }) => ({ role: "admin" }), // spread into the JWT payload
  },
});
```
Session durations can also be set as deployment env vars (`AUTH_SESSION_TOTAL_DURATION_MS`, `AUTH_SESSION_INACTIVE_DURATION_MS`); the config object wins. Refresh tokens are single-use with a 10-second reuse window and refresh-token-reuse detection: any invalid use invalidates the token and all descendants (<https://labs.convex.dev/auth/security>). Rotating `JWT_PRIVATE_KEY` invalidates access tokens, but live WebSocket connections stay authenticated until the current token expires (1 hour by default).

### 12.8 Testing with `convex-test`

Source: <https://docs.convex.dev/testing/convex-test>, plus the `subject` format from §12.6

`convex-test`'s `t.withIdentity({ ... })` builds a `UserIdentity`; "if you don't provide them, `issuer`, `subject` and `tokenIdentifier` will be generated automatically". Convex Auth's helpers only read `subject`, so to make `getAuthUserId` resolve you must **supply `subject` yourself in the `"<userId>|<sessionId>"` form**:

```ts
const t = convexTest(schema);
const userId = await t.run(async (ctx) => ctx.db.insert("users", { email: "a@b.com" }));
const sessionId = await t.run(async (ctx) =>
  ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 86_400_000 }));

const asUser = t.withIdentity({ subject: `${userId}|${sessionId}` });
await asUser.query(api.users.currentUser, {});
```
A bare `t.withIdentity({ name: "Sarah" })` gives an auto-generated `subject`, so `getAuthUserId` returns a garbage string that is not a real `Id<"users">` and `ctx.db.get` on it fails. If a function only needs `getAuthUserId`, the `authSessions` row is optional (`subject: \`${userId}|\``) — but create it if anything calls `getAuthSessionId`.

### 12.9 Local deployments

Convex Auth issues and verifies its own JWTs: `convex/auth.config.ts` points `domain` at `process.env.CONVEX_SITE_URL`, which the same deployment serves, so **password/anonymous sign-in works on a local or anonymous deployment** (`npx convex dev --local`) as long as `JWT_PRIVATE_KEY`, `JWKS` and `SITE_URL` are set on it — `npx @convex-dev/auth --url <local url>` / `--deployment-name` will do that. Set `SITE_URL` to your Next.js dev origin (`http://localhost:3000`). What does **not** work locally is anything needing an inbound public URL: the docs state local deployments have "no public URL … local deployments listen for HTTP requests on your own computer" (<https://docs.convex.dev/cli/local-deployments>), so OAuth provider callbacks and email-provider webhooks into `.convex.site` need a cloud dev deployment (or a tunnel). Env vars are per-deployment: switching between local and cloud means re-running the setup CLI.

### 12.10 Debugging

Source: <https://labs.convex.dev/auth/debugging>

```ts
new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!, { verbose: true });      // browser console
export default convexAuthNextjsMiddleware(handler, { verbose: true });             // next dev terminal
```
```bash
npx convex env set AUTH_LOG_LEVEL DEBUG   # Convex dashboard logs; logs tokens — debug only
```
When state gets wedged, clear localStorage / cookies / secure storage keys prefixed `__convexAuth` (`__Host-convexAuth` for Next.js). Actual cookie/storage keys in 0.0.95: `__convexAuthJWT`, `__convexAuthRefreshToken`, `__convexAuthOAuthVerifier`, `__convexAuthServerStateFetchTime`.

### 12.11 Gotchas

1. **Beta / early preview.** The docs say so on the landing page and in the FAQ, and explicitly still recommend Clerk/Auth0 for "featureful" auth (SSO, MFA). React-only client libraries — no Vue/Svelte/vanilla bindings.
2. **`identity.subject` is `"<userId>|<sessionId>"`, not a user id.** Always go through `getAuthUserId` / `getAuthSessionId`. This is the single biggest difference from Clerk/Better Auth, and it is what makes naive `convex-test` identities fail.
3. **The setup CLI does not write your schema or frontend.** You must add `...authTables` and the provider component yourself; forgetting `authTables` yields index-not-found errors at sign-in.
4. **`@auth/core` is version-pinned** (`@auth/core@0.41.1` in the docs). It is a real dependency, not a peer nicety — provider configs are Auth.js types.
5. **The CLI rewrites `convex/tsconfig.json`** (`moduleResolution: "Bundler"`, `skipLibCheck: true`). Without it, the provider imports don't typecheck.
6. **`flow: "signUp" | "signIn"` is a parameter of the `password` provider**, not a distinct provider name, and it is easy to miss that `signIn(...)` takes `FormData` directly.
7. **Extending `users` means inlining the whole table**, not spreading `authTables.users`; required custom fields break any provider that can't supply them.
8. **Env vars are per-deployment.** `JWT_PRIVATE_KEY`, `JWKS`, `SITE_URL` must be set separately on dev, preview and prod (`npx @convex-dev/auth --prod`). A stale `SITE_URL` silently breaks magic links/OAuth redirects.
9. **Next 16 renamed `middleware.ts` to `proxy.ts`; the Convex Auth docs have not caught up.** The library itself is filename-agnostic — `export default convexAuthNextjsMiddleware()` works from `proxy.ts`.
10. **Server Components must not mutate.** `convexAuthNextjsToken()` + `fetchQuery`/`preloadQuery` only; mutations belong in Server Actions or POST Route Handlers.
11. **`isAuthenticatedNextjs()` in a layout is a documented pitfall** — layouts don't re-render per navigation; do the check in middleware/proxy or the page.
12. **`signIn` config key is misspelled in the library**: `maxFailedAttempsPerHour` (not `Attempts`).
13. **Refresh-token reuse kills the whole session.** Two clients racing a refresh (e.g. a stale tab) can log the user out; the 10-second reuse window is the only slack.
14. **`store` and `isAuthenticated` must stay exported and public** from `convex/auth.ts` — the client calls them by name.
