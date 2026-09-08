import Link from "next/link";

import { Badge } from "@/components/ui";
import type { api } from "@/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";

/** One row of `runs.list` / `views.team.recentRuns` — the trace list item. */
export type RunListItem = FunctionReturnType<typeof api.runs.list>["page"][number];
export type RunStatus = RunListItem["status"];

type BadgeVariant = "outline" | "secondary" | "success" | "warning" | "destructive";

/**
 * Run tags are monochrome outlines by default; only the outcome carries
 * colour — lime for a clean run, red for a failed one, amber for anything the
 * runtime had to work around.
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
  return <Badge variant={STATUS_VARIANTS[status]}>{status.replace("_", " ")}</Badge>;
}

/** Window · team · config vN · model · outcome · cost (PRD 5.8). */
export function RunTags({
  run,
  leagueId,
  showTeam = true,
}: {
  run: RunListItem;
  leagueId: string;
  showTeam?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge variant="outline">
        {run.windowLabelText}
        {run.weekNo ? ` · wk ${run.weekNo}` : ""}
        {run.roundNo > 1 ? ` · r${run.roundNo}` : ""}
      </Badge>
      {showTeam && run.teamId ? (
        <Badge
          variant="outline"
          className="hover:border-brand hover:text-brand"
          render={<Link href={`/leagues/${leagueId}/teams/${run.teamId}`} />}
        >
          {run.teamName ?? "team"}
        </Badge>
      ) : null}
      {run.configVersionNo ? <Badge variant="outline">config v{run.configVersionNo}</Badge> : null}
      <Badge variant="outline" title={run.modelId}>
        {run.modelLabel}
      </Badge>
      <StatusBadge status={run.status} />
      {run.outcome ? <Badge variant="secondary">{run.outcome}</Badge> : null}
      {run.fallbackKind ? <Badge variant="warning">fallback: {run.fallbackKind}</Badge> : null}
      <Badge variant="outline" className="tabular-nums">
        ${run.costUsd.toFixed(4)}
      </Badge>
    </div>
  );
}
