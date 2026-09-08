import { Badge } from "@/components/ui";
import type { api } from "@/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";

type LeagueStatus = FunctionReturnType<typeof api.views.home>["league"]["status"];
type BadgeVariant = "secondary" | "info" | "success" | "outline";

/**
 * Lime (`success`) is spent on the one status that means the league is running;
 * everything else stays monochrome or informational.
 */
const VARIANTS: Record<LeagueStatus, BadgeVariant> = {
  setup: "secondary",
  drafting: "info",
  in_season: "success",
  complete: "outline",
};

const LABELS: Record<LeagueStatus, string> = {
  setup: "setup",
  drafting: "drafting",
  in_season: "in season",
  complete: "complete",
};

export function StatusPill({ status }: { status: LeagueStatus }) {
  return <Badge variant={VARIANTS[status]}>{LABELS[status]}</Badge>;
}
