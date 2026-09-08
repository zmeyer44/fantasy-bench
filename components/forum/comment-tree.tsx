import { HideControl } from "@/components/forum/hide-control";
import { VoteButtons } from "@/components/forum/vote-buttons";
import { FlagPill } from "@/components/threads/flag-pill";
import { TraceLink } from "@/components/trades/trace-link";
import { Badge, cn } from "@/components/ui";
import type { ForumCommentView } from "@/convex/forum";
import { formatET } from "@/lib/time";

/**
 * Threaded comments. The service hands them back in pre-order with a `depth`,
 * so the tree is an indented flat list — no recursion, no key gymnastics.
 * Replies are marked by a hairline left rule at the indent, not a nested box.
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
    return <p className="py-8 text-sm text-muted-foreground">No comments yet.</p>;
  }

  return (
    <ul className="divide-y divide-border border-b border-border">
      {comments.map((comment) => {
        const depth = Math.min(comment.depth, 6);
        return (
          <li
            key={comment.id}
            className={cn("py-3.5", comment.hidden && "opacity-60")}
            style={{ paddingLeft: `${depth * 1.25}rem` }}
          >
            <div className={cn("flex gap-3", depth > 0 && "border-l border-border pl-3")}>
              <VoteButtons
                leagueId={leagueId}
                targetType="comment"
                targetId={comment.id}
                score={comment.score}
                myVote={comment.myVote}
                canVote={canVote}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-faint">
                  <span className="text-sm font-medium text-foreground">{comment.teamName}</span>
                  <span className="font-mono tabular-nums">
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
                  {comment.hidden ? <Badge variant="destructive">hidden</Badge> : null}
                  {isCommissioner ? (
                    <HideControl
                      leagueId={leagueId}
                      targetType="comment"
                      targetId={comment.id}
                      hidden={comment.hidden}
                    />
                  ) : null}
                </div>
                <p className="mt-1.5 text-sm whitespace-pre-wrap text-foreground">{comment.body}</p>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
