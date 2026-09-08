import { Badge, Section, SectionHeader, cn } from "@/components/ui";

import type { FilmRoomEfficiency } from "./lineup-compare";

/**
 * The v1 counterfactual: the best lineup by Sunday-morning projection, scored
 * the same way the agent's lineup was scored.
 *
 * The v1.1 half — "your previous config version would have started Z" — needs a
 * replay of the run against the stored snapshot, which the runtime does not
 * expose yet. The placeholder below is deliberate, not an oversight.
 */
export function CounterfactualPanel({
  efficiency,
  reason,
}: {
  efficiency: FilmRoomEfficiency | null;
  reason: string | null;
}) {
  return (
    <Section>
      <SectionHeader
        title="Counterfactual"
        description="What the best available call was worth."
      />

      <div className="space-y-4">
        {efficiency ? (
          <>
            <dl className="space-y-2">
              <Figure label="Optimal" value={efficiency.optimal.toFixed(2)} tone="brand" />
              <Figure label="Your agent" value={efficiency.actual.toFixed(2)} />
              <Figure
                label="Left on the bench"
                value={`${efficiency.pointsLeftOnBench > 0 ? "−" : ""}${efficiency.pointsLeftOnBench.toFixed(2)}`}
                tone={efficiency.pointsLeftOnBench > 0 ? "destructive" : "faint"}
                last
              />
            </dl>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={efficiency.efficiency >= 0.95 ? "success" : "warning"}>
                {(efficiency.efficiency * 100).toFixed(1)}% efficient
              </Badge>
              <Badge variant="outline">{efficiency.basis} points</Badge>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            n/a — {reason ?? "no stored snapshot for this week."}
          </p>
        )}

        <div className="rounded-lg border border-dashed border-line-strong px-3 py-3">
          <div className="eyebrow mb-2">Coming in v1.1</div>
          <p className="text-sm text-muted-foreground">
            &ldquo;Your previous config version would have started Z.&rdquo; Replaying a run
            against the stored snapshot needs the runtime&apos;s replay path; the snapshots are
            already retained for it.
          </p>
        </div>

        <p className="text-sm text-muted-foreground">
          &ldquo;Optimal&rdquo; is the best lineup by the projection the agent could see at window
          open — a decision-quality measure, not hindsight.
        </p>
      </div>
    </Section>
  );
}

/** One row of the actual-vs-optimal ledger: tracked label left, figure right. */
function Figure({
  label,
  value,
  tone = "default",
  last,
}: {
  label: string;
  value: string;
  tone?: "default" | "brand" | "destructive" | "faint";
  last?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-3",
        last ? undefined : "border-b border-border pb-2",
      )}
    >
      <dt className="eyebrow">{label}</dt>
      <dd
        className={cn(
          "font-mono text-sm font-medium tabular-nums",
          tone === "brand" && "text-brand",
          tone === "destructive" && "text-destructive",
          tone === "faint" && "text-ink-faint",
          tone === "default" && "text-foreground",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
