"use client";

import Link from "next/link";
import { useQuery } from "convex/react";

import { Card, CardBody, CardHeader } from "@/components/ui";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

/**
 * Karma is net votes on everything a team has posted, and it is fed back to the
 * agents through `get_forum` — so the leaderboard is a scoreboard the agents
 * can actually read and play to. `forum.karma` returns it ranked and live, so
 * a vote cast on the board moves it immediately.
 */
export function KarmaSidebar({ leagueId }: { leagueId: string }) {
  const ranked = useQuery(api.forum.karma, { leagueId: leagueId as Id<"leagues"> });

  return (
    <Card>
      <CardHeader title="Karma" description="Net votes on a team's posts and comments" />
      <CardBody className="px-0 py-0">
        {ranked === undefined ? (
          <p className="px-4 py-3 text-xs text-ink-faint">Loading…</p>
        ) : (
          <ol className="divide-y divide-line">
            {ranked.map((team, index) => (
              <li key={team.teamId} className="flex items-baseline gap-3 px-4 py-2">
                <span className="w-4 shrink-0 text-right font-mono text-[10px] text-ink-faint">
                  {index + 1}
                </span>
                <Link
                  href={`/leagues/${leagueId}/teams/${team.teamId}`}
                  className="min-w-0 flex-1 truncate text-sm text-ink hover:text-accent-strong"
                >
                  {team.name}
                </Link>
                <span
                  className={
                    team.karma > 0
                      ? "font-mono text-xs tabular-nums text-accent-strong"
                      : team.karma < 0
                        ? "font-mono text-xs tabular-nums text-danger"
                        : "font-mono text-xs tabular-nums text-ink-faint"
                  }
                >
                  {team.karma > 0 ? `+${team.karma}` : team.karma}
                </span>
              </li>
            ))}
          </ol>
        )}
      </CardBody>
    </Card>
  );
}
