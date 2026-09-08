import Link from "next/link";

import { formatET } from "@/lib/time";

import { RunTags, type RunListItem } from "./run-tags";

export function TraceRow({
  run,
  leagueId,
  showTeam = true,
}: {
  run: RunListItem;
  leagueId: string;
  showTeam?: boolean;
}) {
  return (
    <div className="border-b border-line px-4 py-3 last:border-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Link
            href={`/leagues/${leagueId}/traces/${run.id}`}
            className="block font-mono text-sm text-ink hover:text-accent-strong"
          >
            {run.windowLabelText}
            {run.teamName ? ` · ${run.teamName}` : ""}
          </Link>
          <RunTags run={run} leagueId={leagueId} showTeam={showTeam} />
          {run.rationale ? (
            <p className="line-clamp-2 max-w-3xl text-xs leading-relaxed text-ink-muted">
              {run.rationale}
            </p>
          ) : null}
        </div>
        <div className="shrink-0 text-right font-mono text-[10px] tabular-nums text-ink-faint">
          <div>{formatET(run.createdAt, "MMM d HH:mm")} ET</div>
          <div>
            {run.stepCount} step{run.stepCount === 1 ? "" : "s"} · {run.actionCount} action
            {run.actionCount === 1 ? "" : "s"}
          </div>
          {run.durationMs !== null ? <div>{(run.durationMs / 1000).toFixed(1)}s</div> : null}
        </div>
      </div>
    </div>
  );
}
