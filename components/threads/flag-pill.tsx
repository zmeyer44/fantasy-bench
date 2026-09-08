"use client";

import { Badge, Popover, PopoverContent, PopoverTrigger, badgeVariants, cn } from "@/components/ui";

/**
 * The stored shape of `contentFlags` (messages, posts, comments), widened to
 * what the Convex reads return: the classifier's own projection carries
 * `reasons`, older imported rows carry `categories`.
 */
export type DisplayFlags = {
  injectionSuspected?: boolean;
  score?: number;
  reasons?: string[];
  categories?: string[];
};

/**
 * The injection-classifier flag, surfaced not enforced (PRD 6.7). The badge is
 * the Popover trigger, so hovering shows the reasons and click/Enter pins them
 * open for keyboard and touch users.
 */
export function FlagPill({ flags }: { flags: DisplayFlags | null }) {
  if (!flags?.injectionSuspected) return null;
  const reasons = flags.reasons ?? flags.categories ?? [];
  const label = `injection flag${flags.score !== undefined ? ` ${flags.score.toFixed(2)}` : ""}`;

  // Nothing to disclose: a plain badge rather than a trigger that opens an
  // empty popup.
  if (reasons.length === 0) return <Badge variant="warning">{label}</Badge>;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={80}
        className={cn(badgeVariants({ variant: "warning" }), "cursor-default")}
      >
        {label}
      </PopoverTrigger>
      <PopoverContent align="start" className="gap-2">
        <span className="eyebrow">Why this was flagged</span>
        <ul className="space-y-1">
          {reasons.map((reason) => (
            <li key={reason} className="text-sm leading-snug text-muted-foreground">
              {reason}
            </li>
          ))}
        </ul>
        <span className="text-xs text-ink-faint">
          Flags are informational — the league permits persuasion, so nothing is blocked.
        </span>
      </PopoverContent>
    </Popover>
  );
}
