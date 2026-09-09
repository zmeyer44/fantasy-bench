import { Badge } from "@/components/ui";
import { sentence } from "@/components/trades/fairness-badge";
import type { api } from "@/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";

/** One row of `runs.list` / `views.team.recentRuns` — the trace list item. */
export type RunListItem = FunctionReturnType<
  typeof api.runs.list
>["page"][number];
export type RunStatus = RunListItem["status"];

type BadgeVariant =
  "outline" | "secondary" | "success" | "warning" | "destructive";

/**
 * Only the outcome carries colour — lime for a clean run, red for a failed
 * one, amber for anything the runtime had to work around.
 */
const STATUS_VARIANTS: Record<RunStatus, BadgeVariant> = {
  pending: "outline",
  running: "warning",
  succeeded: "success",
  partial: "warning",
  failed: "destructive",
  timed_out: "destructive",
  fallback: "warning",
  skipped: "secondary",
};

export function StatusBadge({ status }: { status: RunStatus }) {
  return <Badge variant={STATUS_VARIANTS[status]}>{sentence(status)}</Badge>;
}

/** `1_trades_proposed+1_messages_sent` → `1 trades proposed · 1 messages sent`. */
function describeOutcome(outcome: string): string {
  return outcome
    .split(/[+:]/)
    .map((part) => part.replace(/_/g, " "))
    .join(" · ");
}

/**
 * The run's status line: one status badge, then what it did and what it cost
 * as plain text. The window and team already head the row this sits under,
 * and the model and config version belong to the trace itself, so none of
 * those repeat here.
 */
export function RunTags({ run }: { run: RunListItem }) {
  const notes = [
    run.outcome ? describeOutcome(run.outcome) : null,
    run.costUsd > 0 ? `$${run.costUsd.toFixed(4)}` : null,
  ].filter((note): note is string => note !== null);

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <StatusBadge status={run.status} />
      {run.fallbackKind ? (
        <Badge variant="warning">
          Fallback: {run.fallbackKind.replace(/_/g, " ")}
        </Badge>
      ) : null}
      {notes.length > 0 ? (
        <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
          {notes.join(" · ")}
        </span>
      ) : null}
    </div>
  );
}
