import { Badge } from "@/components/ui";

/**
 * The fairness number is deterministic (lib/services/trades/fairness.ts), so the
 * badge is purely a reading of it: green above the floor, amber approaching it,
 * red below.
 */
export function FairnessBadge({
  score,
  flagged,
  floor,
}: {
  score: number | null;
  flagged?: boolean;
  floor?: number;
}) {
  if (score === null || score === undefined) {
    return <Badge tone="outline">unscored</Badge>;
  }
  const limit = floor ?? 0.6;
  const tone = flagged || score < limit ? "danger" : score < limit + 0.15 ? "warning" : "accent";
  return (
    <Badge tone={tone} title={`Fairness ${score.toFixed(2)} (floor ${limit.toFixed(2)})`}>
      fairness {score.toFixed(2)}
    </Badge>
  );
}

export function FlaggedPill({ flagged }: { flagged: boolean }) {
  if (!flagged) return null;
  return (
    <Badge tone="danger" title="Below the league's fairness floor — owners may veto">
      flagged
    </Badge>
  );
}

const STATUS_TONE: Record<string, "neutral" | "accent" | "warning" | "danger" | "outline"> = {
  proposed: "accent",
  countered: "warning",
  accepted: "accent",
  in_review: "warning",
  completed: "accent",
  rejected: "neutral",
  expired: "neutral",
  cancelled: "neutral",
  vetoed: "danger",
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? "outline"}>{status.replace("_", " ")}</Badge>;
}
