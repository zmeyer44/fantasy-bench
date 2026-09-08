"use client";

import Link from "next/link";
import { usePaginatedQuery, usePreloadedQuery, type Preloaded } from "convex/react";

import { JsonBlock } from "@/components/traces/json-block";
import { PromptSections } from "@/components/traces/prompt-sections";
import { RunTags } from "@/components/traces/run-tags";
import { StepCard } from "@/components/traces/step-card";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from "@/components/ui";
import { api } from "@/convex/_generated/api";
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
    <div className="space-y-5">
      {/* Header: tags, timing, cost, outcome, fallback disclosure. */}
      <Card>
        <CardHeader
          title={
            <span className="flex flex-wrap items-center gap-2">
              {run.windowLabelText}
              {detail.team ? <span className="text-ink-muted">· {detail.team.name}</span> : null}
            </span>
          }
          description={
            <span className="font-mono text-[10px]">
              run {run.id}
              {run.attempt > 1 ? ` · attempt ${run.attempt}` : ""}
            </span>
          }
          action={
            <a href={`/api/leagues/${leagueId}/traces/${runId}/export`} download>
              <Button size="sm" variant="secondary">
                Export JSON
              </Button>
            </a>
          }
        />
        <CardBody className="space-y-3">
          <RunTags run={run} leagueId={leagueId} />

          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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
            <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-ink">
              <span className="font-medium">Fallback applied: {run.fallback.kind}.</span>{" "}
              {run.fallback.detail ?? ""}
              {run.fallback.fromModelId && run.fallback.toModelId ? (
                <>
                  {" "}
                  Model switched from <code className="font-mono">{run.fallback.fromModelId}</code>{" "}
                  to <code className="font-mono">{run.fallback.toModelId}</code>.
                </>
              ) : null}
            </div>
          ) : null}

          {run.error ? (
            <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
              {run.error}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3 text-[10px] text-ink-faint">
            <span className="font-mono">
              window opens {formatET(detail.window.opensAt, "MMM d HH:mm")} · deadline{" "}
              {formatET(detail.window.submissionDeadlineAt, "HH:mm")} · closes{" "}
              {formatET(detail.window.closesAt, "HH:mm")} ET
            </span>
            {detail.window.snapshotId ? (
              <Badge tone="outline">snapshot {detail.window.snapshotId.slice(0, 8)}</Badge>
            ) : null}
            {detail.configVersion ? (
              <Link
                href={`/leagues/${leagueId}/teams/${detail.team?.id ?? ""}/config/versions`}
                className="hover:text-accent-strong"
              >
                config v{detail.configVersion.versionNo}
                {detail.configVersion.changeSummary
                  ? ` — ${detail.configVersion.changeSummary}`
                  : ""}
              </Link>
            ) : null}
          </div>

          {loaded.length > 1 ? (
            <div className="flex flex-wrap items-center gap-1.5 border-t border-line pt-3">
              <span className="eyebrow mr-1">Jump to</span>
              {loaded.map((step) => (
                <a
                  key={step.id}
                  href={`#step-${step.stepIndex}`}
                  className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-muted hover:border-accent hover:text-accent-strong"
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
        </CardBody>
      </Card>

      <PromptSections sections={detail.promptSections} source={detail.promptSectionsSource} />

      <div className="space-y-3">
        {steps.status === "LoadingFirstPage" ? (
          <Card>
            <CardBody>
              <p className="text-sm text-ink-muted">Loading steps…</p>
            </CardBody>
          </Card>
        ) : loaded.length === 0 ? (
          <Card>
            <CardBody>
              <p className="text-sm text-ink-muted">
                This run recorded no steps
                {run.status === "fallback" ? " — the fallback path ran instead of the model." : "."}
              </p>
            </CardBody>
          </Card>
        ) : (
          loaded.map((step) => <StepCard key={step.id} step={step} />)
        )}

        {steps.status === "CanLoadMore" || steps.status === "LoadingMore" ? (
          <div className="flex justify-center">
            <Button
              size="sm"
              variant="secondary"
              disabled={steps.isLoading}
              onClick={() => steps.loadMore(STEP_PAGE_SIZE)}
            >
              {steps.status === "LoadingMore"
                ? "Loading…"
                : `Load more steps (${loaded.length} of ${run.stepCount})`}
            </Button>
          </div>
        ) : null}
      </div>

      {run.rationale ? (
        <Card>
          <CardHeader title="Rationale" description="The agent's public explanation" />
          <CardBody>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{run.rationale}</p>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Committed actions"
          description={`${detail.actions.length} write tool call${
            detail.actions.length === 1 ? "" : "s"
          }`}
        />
        {detail.actions.length === 0 ? (
          <CardBody>
            <p className="text-sm text-ink-muted">This run committed nothing.</p>
          </CardBody>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Step</TH>
                <TH>Action</TH>
                <TH>Result</TH>
                <TH>Committed</TH>
                <TH>Payload</TH>
              </TR>
            </THead>
            <TBody>
              {detail.actions.map((action) => (
                <TR key={action.id}>
                  <TD className="font-mono text-xs">
                    <a
                      href={`#step-${action.stepIndex}`}
                      className="text-ink-faint hover:text-accent-strong"
                    >
                      #{action.stepIndex}
                    </a>
                  </TD>
                  <TD className="font-mono text-xs text-ink">{action.actionType}</TD>
                  <TD>
                    {action.validationResult.ok ? (
                      <Badge tone="accent">ok</Badge>
                    ) : (
                      <span className="flex flex-wrap items-center gap-1">
                        <Badge tone="danger">rejected</Badge>
                        <span className="text-[10px] text-danger">
                          {(action.validationResult.errors ?? []).join("; ")}
                        </span>
                      </span>
                    )}
                  </TD>
                  <TD className="font-mono text-[10px] text-ink-muted">
                    {action.committedAt ? formatET(action.committedAt, "HH:mm:ss") : "—"}
                  </TD>
                  <TD className="max-w-md">
                    <details>
                      <summary className="cursor-pointer font-mono text-[10px] text-ink-faint hover:text-ink">
                        show
                      </summary>
                      <JsonBlock value={action.payload} className="mt-1.5" />
                    </details>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Usage ledger"
          description="One row per model call, straight off the run's usage events. Totals come off the run."
        />
        {usage.status === "LoadingFirstPage" ? (
          <CardBody>
            <p className="text-sm text-ink-muted">Loading usage…</p>
          </CardBody>
        ) : usage.results.length === 0 ? (
          <CardBody>
            <p className="text-sm text-ink-muted">No usage recorded.</p>
          </CardBody>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Step</TH>
                <TH>Model</TH>
                <TH numeric>In</TH>
                <TH numeric>Cached</TH>
                <TH numeric>Out</TH>
                <TH numeric>Reasoning</TH>
                <TH numeric>Latency</TH>
                <TH numeric>Cost</TH>
              </TR>
            </THead>
            <TBody>
              {usage.results.map((event, index) => (
                <TR key={`${event.stepIndex}-${index}`}>
                  <TD className="font-mono text-xs">#{event.stepIndex}</TD>
                  <TD className="font-mono text-[10px] text-ink-muted">
                    {event.modelId}
                    <span className="text-ink-faint"> · {event.provider}</span>
                  </TD>
                  <TD numeric className="font-mono text-xs">
                    {event.inputTokens.toLocaleString()}
                  </TD>
                  <TD numeric className="font-mono text-xs text-ink-muted">
                    {event.cachedInputTokens.toLocaleString()}
                  </TD>
                  <TD numeric className="font-mono text-xs">
                    {event.outputTokens.toLocaleString()}
                  </TD>
                  <TD numeric className="font-mono text-xs text-ink-muted">
                    {event.reasoningTokens.toLocaleString()}
                  </TD>
                  <TD numeric className="font-mono text-xs text-ink-muted">
                    {event.latencyMs !== null ? `${event.latencyMs}ms` : "—"}
                  </TD>
                  <TD numeric className="font-mono text-xs">
                    ${event.costUsd.toFixed(5)}
                    {event.gatewayCostUsd === null ? (
                      <span className="block text-[10px] text-ink-faint">computed</span>
                    ) : null}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        {usage.status === "CanLoadMore" || usage.status === "LoadingMore" ? (
          <CardFooter className="flex justify-center">
            <Button
              size="sm"
              variant="secondary"
              disabled={usage.isLoading}
              onClick={() => usage.loadMore(USAGE_PAGE_SIZE)}
            >
              {usage.status === "LoadingMore"
                ? "Loading…"
                : `Load more rows (${usage.results.length} so far)`}
            </Button>
          </CardFooter>
        ) : null}
        <CardFooter>
          Run totals: {detail.usage.inputTokens.toLocaleString()} in ·{" "}
          {detail.usage.outputTokens.toLocaleString()} out · $
          {detail.usage.costUsd.toFixed(5)} over {detail.usage.stepCount} step
          {detail.usage.stepCount === 1 ? "" : "s"}.
        </CardFooter>
      </Card>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-1 font-mono text-xs tabular-nums text-ink">{value}</dd>
    </div>
  );
}
