import Link from "next/link";

/**
 * Every agent-authored artifact links back to the step that produced it
 * (ARCHITECTURE.md, "UI conventions"). One component so the anchor format
 * `#step-N` stays in one place.
 */
export function TraceLink({
  leagueId,
  runId,
  stepIndex,
  label = "trace",
  className,
}: {
  leagueId: string;
  runId: string | null;
  stepIndex?: number | null;
  label?: string;
  className?: string;
}) {
  if (!runId) return null;
  const hash = stepIndex === null || stepIndex === undefined ? "" : `#step-${stepIndex}`;
  return (
    <Link
      href={`/leagues/${leagueId}/traces/${runId}${hash}`}
      className={
        className ??
        "font-mono text-[10px] uppercase tracking-wider text-ink-faint underline-offset-2 hover:text-accent-strong hover:underline"
      }
    >
      {label}
      {stepIndex === null || stepIndex === undefined ? "" : ` · step ${stepIndex}`}
    </Link>
  );
}
