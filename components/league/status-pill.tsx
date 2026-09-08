import { Badge, type BadgeTone } from "@/components/ui";
import type { LeagueStatus } from "@/lib/db/types";

const TONES: Record<LeagueStatus, BadgeTone> = {
  setup: "outline",
  drafting: "warning",
  in_season: "accent",
  complete: "neutral",
};

const LABELS: Record<LeagueStatus, string> = {
  setup: "setup",
  drafting: "drafting",
  in_season: "in season",
  complete: "complete",
};

export function StatusPill({ status }: { status: LeagueStatus }) {
  return <Badge tone={TONES[status]}>{LABELS[status]}</Badge>;
}
