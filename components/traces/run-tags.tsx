import Link from "next/link";

import { Badge, type BadgeTone } from "@/components/ui";
import type { RunStatus } from "@/lib/db/types";
import type { TraceListItem } from "@/lib/services/views";

const STATUS_TONES: Record<RunStatus, BadgeTone> = {
  pending: "outline",
  running: "warning",
  succeeded: "accent",
  partial: "warning",
  failed: "danger",
  timed_out: "danger",
  fallback: "warning",
  skipped: "neutral",
};

export function StatusBadge({ status }: { status: RunStatus }) {
  return <Badge tone={STATUS_TONES[status]}>{status.replace("_", " ")}</Badge>;
}

/** Window · team · config vN · model · outcome · cost (PRD 5.8). */
export function RunTags({
  run,
  leagueId,
  showTeam = true,
}: {
  run: TraceListItem;
  leagueId: string;
  showTeam?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge tone="outline">
        {run.windowLabelText}
        {run.weekNo ? ` · wk ${run.weekNo}` : ""}
        {run.roundNo > 1 ? ` · r${run.roundNo}` : ""}
      </Badge>
      {showTeam && run.teamId ? (
        <Link href={`/leagues/${leagueId}/teams/${run.teamId}`}>
          <Badge tone="neutral" className="hover:border-accent">
            {run.teamName ?? "team"}
          </Badge>
        </Link>
      ) : null}
      {run.configVersionNo ? <Badge tone="outline">config v{run.configVersionNo}</Badge> : null}
      <Badge tone="outline" title={run.modelId}>
        {run.modelLabel}
      </Badge>
      <StatusBadge status={run.status} />
      {run.outcome ? <Badge tone="neutral">{run.outcome}</Badge> : null}
      {run.fallbackKind ? <Badge tone="warning">fallback: {run.fallbackKind}</Badge> : null}
      <Badge tone="outline">${run.costUsd.toFixed(4)}</Badge>
    </div>
  );
}
