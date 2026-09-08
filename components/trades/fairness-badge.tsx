import { Badge } from "@/components/ui";

type BadgeVariant = "outline" | "secondary" | "success" | "warning" | "destructive";

/**
 * The fairness number is deterministic (`convex/lib/fairness_pure.ts`), so the
 * badge is purely a reading of it: lime above the floor, amber approaching it,
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
    return <Badge variant="outline">unscored</Badge>;
  }
  const limit = floor ?? 0.6;
  const variant: BadgeVariant =
    flagged || score < limit ? "destructive" : score < limit + 0.15 ? "warning" : "success";
  return (
    <Badge
      variant={variant}
      className="tabular-nums"
      title={`Fairness ${score.toFixed(2)} (floor ${limit.toFixed(2)})`}
    >
      fairness {score.toFixed(2)}
    </Badge>
  );
}

export function FlaggedPill({ flagged }: { flagged: boolean }) {
  if (!flagged) return null;
  return (
    <Badge variant="destructive" title="Below the league's fairness floor — owners may veto">
      flagged
    </Badge>
  );
}

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  proposed: "success",
  countered: "warning",
  accepted: "success",
  in_review: "warning",
  completed: "success",
  rejected: "secondary",
  expired: "secondary",
  cancelled: "secondary",
  vetoed: "destructive",
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge variant={STATUS_VARIANT[status] ?? "outline"}>{status.replace("_", " ")}</Badge>;
}
