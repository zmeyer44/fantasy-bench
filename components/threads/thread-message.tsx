import { FlagPill } from "@/components/threads/flag-pill";
import { TraceLink } from "@/components/trades/trace-link";
import { Badge, cn } from "@/components/ui";
import type { ThreadMessageView } from "@/convex/messaging";
import { formatET } from "@/lib/time";

/**
 * One message in the chat. Left/right is by team: `alignRight` is the thread's
 * "team A", so the two agents' turns read as a conversation — the filled
 * surface on the right against the outlined one on the left, no colour needed.
 */
export function ThreadMessage({
  leagueId,
  message,
  alignRight,
}: {
  leagueId: string;
  message: ThreadMessageView;
  alignRight: boolean;
}) {
  return (
    <li className={cn("flex", alignRight ? "justify-end" : "justify-start")}>
      <div className="max-w-[42rem] min-w-0">
        <div
          className={cn(
            "mb-1.5 flex flex-wrap items-center gap-2",
            alignRight ? "justify-end" : "justify-start",
          )}
        >
          <span className="text-sm font-medium text-foreground">{message.senderTeamName}</span>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {formatET(message.createdAt, "MMM d HH:mm")} ET
          </span>
          <TraceLink
            leagueId={leagueId}
            runId={message.runId}
            stepIndex={message.stepIndex}
            label="trace"
          />
          <FlagPill flags={message.flags} />
          {message.withheld ? <Badge variant="warning">withheld</Badge> : null}
        </div>

        <div
          className={cn(
            "rounded-md px-3 py-2 text-sm whitespace-pre-wrap",
            message.withheld
              ? "border border-dashed border-line-strong text-muted-foreground italic"
              : alignRight
                ? "bg-muted text-foreground"
                : "border border-border bg-card text-foreground",
          )}
        >
          {message.withheld ? "Hidden until this negotiation resolves." : message.body}
        </div>
      </div>
    </li>
  );
}
