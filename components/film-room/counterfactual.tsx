import { Badge, Card, CardBody, CardFooter, CardHeader } from "@/components/ui";

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
    <Card>
      <CardHeader
        title="Counterfactual"
        description="What the best available call was worth."
      />
      <CardBody className="space-y-4">
        {efficiency ? (
          <>
            <p className="text-sm text-ink">
              Your optimal lineup would have scored{" "}
              <span className="font-mono font-semibold tabular-nums text-accent-strong">
                {efficiency.optimal.toFixed(2)}
              </span>
              . Your agent scored{" "}
              <span className="font-mono font-semibold tabular-nums">
                {efficiency.actual.toFixed(2)}
              </span>
              .
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={efficiency.efficiency >= 0.95 ? "accent" : "warning"}>
                {(efficiency.efficiency * 100).toFixed(1)}% efficient
              </Badge>
              <Badge tone={efficiency.pointsLeftOnBench > 0 ? "danger" : "outline"}>
                {efficiency.pointsLeftOnBench.toFixed(2)} left on the bench
              </Badge>
              <Badge tone="outline">{efficiency.basis} points</Badge>
            </div>
          </>
        ) : (
          <p className="text-sm text-ink-muted">
            n/a — {reason ?? "no stored snapshot for this week."}
          </p>
        )}

        <div className="rounded-md border border-dashed border-line-strong px-3 py-3">
          <div className="eyebrow mb-1">Coming in v1.1</div>
          <p className="text-sm text-ink-muted">
            &ldquo;Your previous config version would have started Z.&rdquo; Replaying a run against
            the stored snapshot needs the runtime&apos;s replay path; the snapshots are already
            retained for it.
          </p>
        </div>
      </CardBody>
      <CardFooter>
        &ldquo;Optimal&rdquo; is the best lineup by the projection the agent could see at window
        open — a decision-quality measure, not hindsight.
      </CardFooter>
    </Card>
  );
}
