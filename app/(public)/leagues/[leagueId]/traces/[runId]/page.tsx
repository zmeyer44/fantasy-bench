import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { JsonBlock } from "@/components/traces/json-block";
import { PromptSections } from "@/components/traces/prompt-sections";
import { RunTags } from "@/components/traces/run-tags";
import { StepCard } from "@/components/traces/step-card";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from "@/components/ui";
import { trace } from "@/lib/services/views";
import { formatET } from "@/lib/time";

export async function generateMetadata({
  params,
}: PageProps<"/leagues/[leagueId]/traces/[runId]">): Promise<Metadata> {
  const { runId } = await params;
  const detail = await trace(runId);
  if (!detail) return { title: "Trace" };
  return {
    title: `${detail.run.windowLabelText}${detail.team ? ` · ${detail.team.name}` : ""}`,
  };
}

/**
 * The trace viewer (PRD 5.8).
 *
 * Rendered entirely on the server: the prompt sections, tool-call arguments and
 * tool results are `<details>` elements that ship as plain HTML, so a 30-step
 * run paints without a hydration pass and without a JSON viewer bundle.
 */
export default async function TraceViewerPage({
  params,
}: PageProps<"/leagues/[leagueId]/traces/[runId]">) {
  const { leagueId, runId } = await params;
  const detail = await trace(runId);
  if (!detail || detail.run.leagueId !== leagueId) notFound();

  const { run } = detail;
  const totalUsage = detail.usage.reduce(
    (acc, event) => ({
      input: acc.input + event.inputTokens,
      output: acc.output + event.outputTokens,
      cost: acc.cost + event.costUsd,
    }),
    { input: 0, output: 0, cost: 0 },
  );

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
              value={`${(run.totalInputTokens || totalUsage.input).toLocaleString()} in / ${(
                run.totalOutputTokens || totalUsage.output
              ).toLocaleString()} out`}
            />
            <Metric label="Cost" value={`$${(run.costUsd || totalUsage.cost).toFixed(5)}`} />
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

          {detail.steps.length > 1 ? (
            <div className="flex flex-wrap items-center gap-1.5 border-t border-line pt-3">
              <span className="eyebrow mr-1">Jump to</span>
              {detail.steps.map((step) => (
                <a
                  key={step.id}
                  href={`#step-${step.stepIndex}`}
                  className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-muted hover:border-accent hover:text-accent-strong"
                >
                  {step.stepIndex}
                </a>
              ))}
            </div>
          ) : null}
        </CardBody>
      </Card>

      <PromptSections sections={detail.promptSections} source={detail.promptSectionsSource} />

      <div className="space-y-3">
        {detail.steps.length === 0 ? (
          <Card>
            <CardBody>
              <p className="text-sm text-ink-muted">
                This run recorded no steps
                {run.status === "fallback"
                  ? " — the fallback path ran instead of the model."
                  : "."}
              </p>
            </CardBody>
          </Card>
        ) : (
          detail.steps.map((step) => <StepCard key={step.id} step={step} />)
        )}
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

      {detail.usage.length > 0 ? (
        <Card>
          <CardHeader title="Usage ledger" description="One row per model call, append-only" />
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
              {detail.usage.map((event) => (
                <TR key={event.id}>
                  <TD className="font-mono text-xs">#{event.stepIndex}</TD>
                  <TD className="font-mono text-[10px] text-ink-muted">{event.modelId}</TD>
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
                    ${(event.gatewayCostUsd ?? event.costUsd).toFixed(5)}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      ) : null}
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
