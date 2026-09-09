"use client";

import { Download } from "lucide-react";
import Link from "next/link";
import { usePaginatedQuery, usePreloadedQuery, type Preloaded } from "convex/react";

import { JsonBlock } from "@/components/traces/json-block";
import { PromptSections } from "@/components/traces/prompt-sections";
import { RunTags } from "@/components/traces/run-tags";
import { StepCard } from "@/components/traces/step-card";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";
import { api } from "@/convex/_generated/api";
import { COOLDOWN_DAYS } from "@/convex/lib/visibility";
import type { Id } from "@/convex/_generated/dataModel";
import { formatET } from "@/lib/time";

/** Steps loaded on the first paint; "load more" pulls another page of this size. */
const STEP_PAGE_SIZE = 10;
/** Usage ledger rows on the first paint; the table has its own "load more". */
const USAGE_PAGE_SIZE = 30;

/**
 * The trace viewer (PRD 5.8).
 *
 * The run document is a live subscription — status, cost and counters move as a
 * run progresses — while the steps come from a paginated query, so opening a
 * 30-step trace does not pull thirty tool payloads. Overflowed tool results
 * (`{ toolCallId, payloadRef }`) are fetched by `StepCard` only when opened.
 *
 * The page is one document read top to bottom: ruled sections, mono
 * identifiers, no boxes inside boxes.
 */
export function TraceView({
  leagueId,
  runId,
  preloaded,
}: {
  leagueId: string;
  runId: string;
  preloaded: Preloaded<typeof api.runs.get>;
}) {
  const detail = usePreloadedQuery(preloaded);
  const steps = usePaginatedQuery(
    api.runs.steps,
    { runId: runId as Id<"runs"> },
    { initialNumItems: STEP_PAGE_SIZE },
  );
  // The ledger is the `usage_events` rows themselves, not a projection of the
  // steps that happen to be loaded: it pages independently and carries the
  // gateway's own cost figure beside the computed one.
  const usage = usePaginatedQuery(
    api.runs.usageEvents,
    { runId: runId as Id<"runs"> },
    { initialNumItems: USAGE_PAGE_SIZE },
  );

  const { run } = detail;
  const loaded = steps.results;

  return (
    <div className="space-y-8">
      {/* Header: tags, timing, cost, outcome, fallback disclosure. */}
      <header className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
          <div className="min-w-0">
            <div className="eyebrow text-brand">Trace</div>
            <h1 className="mt-2.5 flex flex-wrap items-baseline gap-2 text-2xl font-semibold tracking-tight text-foreground">
              {run.windowLabelText}
              {detail.team ? (
                <span className="text-muted-foreground">· {detail.team.name}</span>
              ) : null}
            </h1>
            <p className="mt-1.5 font-mono text-[10px] text-ink-faint">
              run {run.id}
              {run.attempt > 1 ? ` · attempt ${run.attempt}` : ""}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            render={<a href={`/api/leagues/${leagueId}/traces/${runId}/export`} download />}
          >
            <Download data-icon="inline-start" />
            Export JSON
          </Button>
        </div>

        <RunTags run={run} leagueId={leagueId} />

        <dl className="grid grid-cols-2 divide-border border-y border-border sm:grid-cols-4 sm:divide-x">
          <Metric
            label="Started"
            value={run.startedAt ? `${formatET(run.startedAt, "MMM d HH:mm:ss")} ET` : "—"}
          />
          <Metric
            label="Duration"
            value={run.durationMs !== null ? `${(run.durationMs / 1000).toFixed(1)}s` : "—"}
          />
          <Metric
            label="Tokens"
            value={`${detail.usage.inputTokens.toLocaleString()} in / ${detail.usage.outputTokens.toLocaleString()} out`}
          />
          <Metric label="Cost" value={`$${detail.usage.costUsd.toFixed(5)}`} />
        </dl>

        {run.fallback ? (
          <Alert className="border-warning/40">
            <AlertDescription className="text-foreground">
              <span className="font-medium text-warning">
                Fallback applied: {run.fallback.kind}.
              </span>{" "}
              {run.fallback.detail ?? ""}
              {run.fallback.fromModelId && run.fallback.toModelId ? (
                <>
                  {" "}
                  Model switched from <code className="font-mono">{run.fallback.fromModelId}</code>{" "}
                  to <code className="font-mono">{run.fallback.toModelId}</code>.
                </>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        {run.error ? (
          <Alert variant="destructive" className="border-destructive/40">
            <AlertDescription className="font-mono text-xs text-destructive">
              {run.error}
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center gap-3 text-[10px] text-ink-faint">
          <span className="font-mono">
            window opens {formatET(detail.window.opensAt, "MMM d HH:mm")} · deadline{" "}
            {formatET(detail.window.submissionDeadlineAt, "HH:mm")} · closes{" "}
            {formatET(detail.window.closesAt, "HH:mm")} ET
          </span>
          {detail.window.snapshotId ? (
            <Badge variant="outline">snapshot {detail.window.snapshotId.slice(0, 8)}</Badge>
          ) : null}
          {detail.configVersion ? (
            <Link
              href={`/leagues/${leagueId}/teams/${detail.team?.id ?? ""}/config/versions`}
              className="font-mono hover:text-brand-strong"
            >
              config v{detail.configVersion.versionNo}
              {detail.configVersion.changeSummary
                ? ` — ${detail.configVersion.changeSummary}`
                : ""}
            </Link>
          ) : null}
        </div>

        {loaded.length > 1 ? (
          <div className="flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
            <span className="eyebrow mr-1">Jump to</span>
            {loaded.map((step) => (
              <a
                key={step.id}
                href={`#step-${step.stepIndex}`}
                className="rounded-sm border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-brand hover:text-brand-strong"
              >
                {step.stepIndex}
              </a>
            ))}
            {steps.status === "CanLoadMore" || steps.status === "LoadingMore" ? (
              <span className="font-mono text-[10px] text-ink-faint">
                · {run.stepCount} step{run.stepCount === 1 ? "" : "s"} in total
              </span>
            ) : null}
          </div>
        ) : null}
      </header>

      {detail.privateUntil ? (
        <p className="border-l-2 border-line-strong pl-3 text-sm text-muted-foreground">
          The owner&apos;s context, skills, tool guidance and custom-tool calls in this trace are
          private until {formatET(detail.privateUntil, "MMM d, HH:mm")} ET. Customizations become
          public {COOLDOWN_DAYS} days after a run.
        </p>
      ) : null}

      <PromptSections sections={detail.promptSections} source={detail.promptSectionsSource} />

      <section>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border pb-2">
          <h2 className="eyebrow text-foreground">Steps</h2>
          <p className="font-mono text-[10px] tabular-nums text-ink-faint">
            {run.stepCount} model call{run.stepCount === 1 ? "" : "s"}
          </p>
        </div>

        {steps.status === "LoadingFirstPage" ? (
          <p className="py-3 text-sm text-muted-foreground">Loading steps…</p>
        ) : loaded.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">
            This run recorded no steps
            {run.status === "fallback" ? " — the fallback path ran instead of the model." : "."}
          </p>
        ) : (
          <div>
            {loaded.map((step) => (
              <StepCard key={step.id} step={step} />
            ))}
          </div>
        )}

        {steps.status === "CanLoadMore" || steps.status === "LoadingMore" ? (
          <div className="flex justify-center pt-4">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={steps.isLoading}
              onClick={() => steps.loadMore(STEP_PAGE_SIZE)}
            >
              {steps.status === "LoadingMore"
                ? "Loading…"
                : `Load more steps (${loaded.length} of ${run.stepCount})`}
            </Button>
          </div>
        ) : null}
      </section>

      {run.rationale ? (
        <section>
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border pb-2">
            <h2 className="eyebrow text-foreground">Rationale</h2>
            <p className="font-mono text-[10px] text-ink-faint">the agent&apos;s public explanation</p>
          </div>
          <p className="whitespace-pre-wrap pt-3 text-sm leading-relaxed text-foreground">
            {run.rationale}
          </p>
        </section>
      ) : null}

      <section>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border pb-2">
          <h2 className="eyebrow text-foreground">Committed actions</h2>
          <p className="font-mono text-[10px] tabular-nums text-ink-faint">
            {detail.actions.length} write tool call{detail.actions.length === 1 ? "" : "s"}
          </p>
        </div>

        {detail.actions.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">This run committed nothing.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Step</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Result</TableHead>
                <TableHead>Committed</TableHead>
                <TableHead>Payload</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.actions.map((action) => (
                <TableRow key={action.id}>
                  <TableCell className="font-mono text-xs">
                    <a
                      href={`#step-${action.stepIndex}`}
                      className="text-ink-faint hover:text-brand-strong"
                    >
                      #{action.stepIndex}
                    </a>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-foreground">
                    {action.actionType}
                  </TableCell>
                  <TableCell>
                    {action.validationResult.ok ? (
                      <Badge variant="success">ok</Badge>
                    ) : (
                      <span className="flex flex-wrap items-center gap-1">
                        <Badge variant="destructive">rejected</Badge>
                        <span className="text-xs text-destructive">
                          {(action.validationResult.errors ?? []).join("; ")}
                        </span>
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-[10px] text-muted-foreground">
                    {action.committedAt ? formatET(action.committedAt, "HH:mm:ss") : "—"}
                  </TableCell>
                  <TableCell className="max-w-md whitespace-normal">
                    <details>
                      <summary className="cursor-pointer font-mono text-[10px] text-ink-faint hover:text-foreground">
                        show
                      </summary>
                      <JsonBlock value={action.payload} className="mt-1.5" />
                    </details>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border pb-2">
          <h2 className="eyebrow text-foreground">Usage ledger</h2>
          <p className="font-mono text-[10px] text-ink-faint">one row per model call</p>
        </div>

        {usage.status === "LoadingFirstPage" ? (
          <p className="py-3 text-sm text-muted-foreground">Loading usage…</p>
        ) : usage.results.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">No usage recorded.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Step</TableHead>
                <TableHead>Model</TableHead>
                <TableHead numeric>In</TableHead>
                <TableHead numeric>Cached</TableHead>
                <TableHead numeric>Out</TableHead>
                <TableHead numeric>Reasoning</TableHead>
                <TableHead numeric>Latency</TableHead>
                <TableHead numeric>Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usage.results.map((event, index) => (
                <TableRow key={`${event.stepIndex}-${index}`}>
                  <TableCell className="font-mono text-xs">#{event.stepIndex}</TableCell>
                  <TableCell className="font-mono text-[10px] text-muted-foreground">
                    {event.modelId}
                    <span className="text-ink-faint"> · {event.provider}</span>
                  </TableCell>
                  <TableCell numeric className="font-mono text-xs">
                    {event.inputTokens.toLocaleString()}
                  </TableCell>
                  <TableCell numeric className="font-mono text-xs text-muted-foreground">
                    {event.cachedInputTokens.toLocaleString()}
                  </TableCell>
                  <TableCell numeric className="font-mono text-xs">
                    {event.outputTokens.toLocaleString()}
                  </TableCell>
                  <TableCell numeric className="font-mono text-xs text-muted-foreground">
                    {event.reasoningTokens.toLocaleString()}
                  </TableCell>
                  <TableCell numeric className="font-mono text-xs text-muted-foreground">
                    {event.latencyMs !== null ? `${event.latencyMs}ms` : "—"}
                  </TableCell>
                  <TableCell numeric className="font-mono text-xs">
                    ${event.costUsd.toFixed(5)}
                    {event.gatewayCostUsd === null ? (
                      <span className="block text-[10px] text-ink-faint">computed</span>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {usage.status === "CanLoadMore" || usage.status === "LoadingMore" ? (
          <div className="flex justify-center pt-4">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={usage.isLoading}
              onClick={() => usage.loadMore(USAGE_PAGE_SIZE)}
            >
              {usage.status === "LoadingMore"
                ? "Loading…"
                : `Load more rows (${usage.results.length} so far)`}
            </Button>
          </div>
        ) : null}

        <p className="mt-3 border-t border-border pt-3 font-mono text-[10px] tabular-nums text-ink-faint">
          Run totals: {detail.usage.inputTokens.toLocaleString()} in ·{" "}
          {detail.usage.outputTokens.toLocaleString()} out · ${detail.usage.costUsd.toFixed(5)} over{" "}
          {detail.usage.stepCount} step{detail.usage.stepCount === 1 ? "" : "s"}.
        </p>
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 px-4 py-3 first:pl-0 last:pr-0">
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-2 font-mono text-sm tabular-nums text-foreground">{value}</dd>
    </div>
  );
}
