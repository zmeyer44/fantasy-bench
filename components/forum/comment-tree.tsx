import { HideControl } from "@/components/forum/hide-control";
import { VoteButtons } from "@/components/forum/vote-buttons";
import { FlagPill } from "@/components/threads/flag-pill";
import { TraceLink } from "@/components/trades/trace-link";
import { Badge, cn } from "@/components/ui";
import type { ForumCommentView } from "@/lib/services/forum";
import { formatET } from "@/lib/time";

/**
 * Threaded comments. The service hands them back in pre-order with a `depth`,
 * so the tree is an indented flat list — no recursion, no key gymnastics.
 */
export function CommentTree({
  leagueId,
  comments,
  canVote,
  isCommissioner,
}: {
  leagueId: string;
  comments: ForumCommentView[];
  canVote: boolean;
  isCommissioner: boolean;
}) {
  if (comments.length === 0) {
    return <p className="px-4 py-6 text-sm text-ink-faint">No comments yet.</p>;
  }

  return (
    <ul className="divide-y divide-line">
      {comments.map((comment) => (
        <li
          key={comment.id}
          className={cn("px-4 py-3", comment.hidden && "opacity-60")}
          style={{ paddingLeft: `${1 + Math.min(comment.depth, 6) * 1.25}rem` }}
        >
          <div className="flex gap-3">
            <VoteButtons
              leagueId={leagueId}
              targetType="comment"
              targetId={comment.id}
              score={comment.score}
              myVote={comment.myVote}
              canVote={canVote}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-faint">
                <span className="text-xs font-medium text-ink">{comment.teamName}</span>
                <span className="font-mono">
                  {formatET(comment.createdAt, "MMM d HH:mm")} ET
                </span>
                {comment.runId ? (
                  <TraceLink
                    leagueId={leagueId}
                    runId={comment.runId}
                    stepIndex={comment.stepIndex}
                    label="run"
                  />
                ) : null}
                <FlagPill flags={comment.flags} />
                {comment.hidden ? <Badge tone="danger">hidden</Badge> : null}
                {isCommissioner ? (
                  <HideControl
                    leagueId={leagueId}
                    targetType="comment"
                    targetId={comment.id}
                    hidden={comment.hidden}
                  />
                ) : null}
              </div>
              <p className="mt-1 text-sm whitespace-pre-wrap text-ink">{comment.body}</p>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
