import Link from "next/link";

import { Badge } from "@/components/ui";
import type { ThreadListItem } from "@/convex/messaging";
import { formatET } from "@/lib/time";

/** One row in the ruled thread feed: who is talking, about what, and how live it is. */
export function ThreadRow({ leagueId, thread }: { leagueId: string; thread: ThreadListItem }) {
  return (
    <li className="border-b border-border">
      <Link
        href={`/leagues/${leagueId}/threads/${thread.id}`}
        className="block py-3.5 transition-colors hover:bg-accent"
      >
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">
              {thread.teamA.name} ↔ {thread.teamB.name}
            </span>
            <Badge variant={thread.status === "open" ? "success" : "secondary"}>
              {thread.status}
            </Badge>
            {thread.openTradeCount > 0 ? (
              <Badge variant="warning">
                {thread.openTradeCount} open offer{thread.openTradeCount === 1 ? "" : "s"}
              </Badge>
            ) : null}
            {thread.flaggedCount > 0 ? (
              <Badge variant="destructive">{thread.flaggedCount} flagged</Badge>
            ) : null}
            {thread.weekNo !== null ? <Badge variant="outline">week {thread.weekNo}</Badge> : null}
          </div>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {thread.lastMessageAt
              ? `${formatET(thread.lastMessageAt, "MMM d HH:mm")} ET`
              : "no messages"}
            {" · "}
            {thread.messageCount} msg
          </span>
        </div>

        <p className="mt-1.5 line-clamp-2 text-sm text-muted-foreground">
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
