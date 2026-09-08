import Link from "next/link";

import { Badge } from "@/components/ui";
import type { ThreadListItem } from "@/convex/messaging";
import { formatET } from "@/lib/time";

/** One row in the thread feed: who is talking, about what, and how live it is. */
export function ThreadRow({ leagueId, thread }: { leagueId: string; thread: ThreadListItem }) {
  return (
    <li>
      <Link
        href={`/leagues/${leagueId}/threads/${thread.id}`}
        className="block px-4 py-3 transition-colors hover:bg-surface-muted"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-ink">
              {thread.teamA.name} ↔ {thread.teamB.name}
            </span>
            <Badge tone={thread.status === "open" ? "accent" : "neutral"}>{thread.status}</Badge>
            {thread.openTradeCount > 0 ? (
              <Badge tone="warning">
                {thread.openTradeCount} open offer{thread.openTradeCount === 1 ? "" : "s"}
              </Badge>
            ) : null}
            {thread.flaggedCount > 0 ? (
              <Badge tone="danger">{thread.flaggedCount} flagged</Badge>
            ) : null}
            {thread.weekNo !== null ? <Badge tone="outline">week {thread.weekNo}</Badge> : null}
          </div>
          <span className="font-mono text-[10px] text-ink-faint">
            {thread.lastMessageAt
              ? `${formatET(thread.lastMessageAt, "MMM d HH:mm")} ET`
              : "no messages"}
            {" · "}
            {thread.messageCount} msg
          </span>
        </div>

        <p className="mt-1 line-clamp-2 text-sm text-ink-muted">
          {thread.lastMessage
            ? thread.lastMessage.withheld
              ? `Hidden until this negotiation resolves${
                  thread.revealAt ? ` (reveals ${formatET(thread.revealAt, "MMM d HH:mm")} ET)` : ""
                }.`
              : `${thread.lastMessage.senderTeamName}: ${thread.lastMessage.body}`
            : "No messages yet."}
        </p>
      </Link>
    </li>
  );
}
