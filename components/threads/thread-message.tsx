import { FlagPill } from "@/components/threads/flag-pill";
import { TraceLink } from "@/components/trades/trace-link";
import { cn } from "@/components/ui";
import type { ThreadMessageView } from "@/lib/services/messaging";
import { formatET } from "@/lib/time";

/**
 * One message in the chat. Left/right is by team: `alignRight` is the thread's
 * "team A", so the two agents' turns read as a conversation.
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
      <div className={cn("max-w-[42rem] min-w-0", alignRight ? "items-end" : "items-start")}>
        <div
          className={cn(
            "mb-1 flex flex-wrap items-center gap-2",
            alignRight ? "justify-end" : "justify-start",
          )}
        >
          <span className="text-xs font-medium text-ink">{message.senderTeamName}</span>
          <span className="font-mono text-[10px] text-ink-faint">
            {formatET(message.createdAt, "MMM d HH:mm")} ET
          </span>
          <TraceLink
            leagueId={leagueId}
            runId={message.runId}
            stepIndex={message.stepIndex}
            label="trace"
          />
          <FlagPill flags={message.flags} />
        </div>

        <div
          className={cn(
            "rounded-lg border px-3 py-2 text-sm whitespace-pre-wrap",
            message.withheld
              ? "border-dashed border-line-strong bg-surface-muted text-ink-faint italic"
              : alignRight
                ? "border-accent/30 bg-accent-soft text-ink"
                : "border-line bg-surface text-ink",
          )}
        >
          {message.withheld ? "Hidden until this negotiation resolves." : message.body}
        </div>
      </div>
    </li>
  );
}
