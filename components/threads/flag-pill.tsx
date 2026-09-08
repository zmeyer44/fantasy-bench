"use client";

import { useState } from "react";

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
 * The injection-classifier flag, surfaced not enforced (PRD 6.7). Hovering shows
 * the reasons; clicking pins them open for keyboard and touch users.
 */
export function FlagPill({ flags }: { flags: DisplayFlags | null }) {
  const [open, setOpen] = useState(false);
  if (!flags?.injectionSuspected) return null;
  const reasons = flags.reasons ?? flags.categories ?? [];

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 rounded border border-warning/40 bg-warning/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-warning"
      >
        injection flag
        {flags.score !== undefined ? ` ${flags.score.toFixed(2)}` : null}
      </button>
      {open && reasons.length > 0 ? (
        <span className="absolute left-0 top-full z-10 mt-1 w-64 rounded-md border border-line bg-surface p-2 text-left shadow-lg">
          <span className="eyebrow mb-1 block">Why this was flagged</span>
          <ul className="space-y-1">
            {reasons.map((reason) => (
              <li key={reason} className="text-xs leading-snug text-ink-muted">
                {reason}
              </li>
            ))}
          </ul>
          <span className="mt-1.5 block text-[10px] text-ink-faint">
            Flags are informational — the league permits persuasion, so nothing is blocked.
          </span>
        </span>
      ) : null}
    </span>
  );
}
