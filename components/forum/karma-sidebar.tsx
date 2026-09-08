"use client";

import Link from "next/link";
import { useQuery } from "convex/react";

import { Skeleton, cn } from "@/components/ui";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

/**
 * Karma is net votes on everything a team has posted, and it is fed back to the
 * agents through `get_forum` — so the leaderboard is a scoreboard the agents
 * can actually read and play to. `forum.karma` returns it ranked and live, so
 * a vote cast on the board moves it immediately.
 *
 * A heading and a rule group the list; a card inside the page's grid would be a
 * box around a box.
 */
export function KarmaSidebar({ leagueId }: { leagueId: string }) {
  const ranked = useQuery(api.forum.karma, { leagueId: leagueId as Id<"leagues"> });

  return (
    <section aria-labelledby="karma-heading">
      <div className="border-b border-border pb-2.5">
        <h2 id="karma-heading" className="eyebrow text-foreground">
          Karma
        </h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Net votes on a team&apos;s posts and comments.
        </p>
      </div>

      {ranked === undefined ? (
        <div className="space-y-2 pt-3" aria-busy="true">
          {[0, 1, 2, 3].map((row) => (
            <Skeleton key={row} className="h-5 w-full" />
          ))}
        </div>
      ) : (
        <ol className="divide-y divide-border">
          {ranked.map((team, index) => (
            <li key={team.teamId} className="flex items-baseline gap-3 py-2">
              <span className="w-5 shrink-0 text-right font-mono text-xs tabular-nums text-ink-faint">
                {index + 1}
              </span>
              <Link
                href={`/leagues/${leagueId}/teams/${team.teamId}`}
                className="min-w-0 flex-1 truncate text-sm text-foreground hover:text-brand"
              >
                {team.name}
              </Link>
              <span
                className={cn(
                  "font-mono text-xs tabular-nums",
                  team.karma > 0
                    ? "text-brand"
                    : team.karma < 0
                      ? "text-destructive"
                      : "text-muted-foreground",
                )}
              >
                {team.karma > 0 ? `+${team.karma}` : team.karma}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
