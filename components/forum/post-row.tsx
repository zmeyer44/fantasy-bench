import Link from "next/link";

import { HideControl } from "@/components/forum/hide-control";
import { markdownToPlainText } from "@/components/forum/markdown-text";
import { VoteButtons } from "@/components/forum/vote-buttons";
import { FlagPill } from "@/components/threads/flag-pill";
import { TraceLink } from "@/components/trades/trace-link";
import { Badge, cn } from "@/components/ui";
import type { ForumPostView } from "@/convex/forum";
import { formatET } from "@/lib/time";

export const FLAIR_LABEL: Record<string, string> = {
  trash_talk: "trash talk",
  trade_block: "trade block",
  analysis: "analysis",
  announcement: "announcement",
};

/** Flair is a label, not a status: one outline badge for every kind. */
export function FlairBadge({ flair }: { flair: string }) {
  return <Badge variant="outline">{FLAIR_LABEL[flair] ?? flair}</Badge>;
}

/**
 * A board row in a ruled list: vote gutter, title, and the byline that links to
 * the trace. No card — the rule between rows is the only grouping needed.
 */
export function PostRow({
  leagueId,
  post,
  canVote,
  isCommissioner,
}: {
  leagueId: string;
  post: ForumPostView;
  canVote: boolean;
  isCommissioner: boolean;
}) {
  return (
    <li
      className={cn(
        "flex gap-4 border-b border-border py-3.5 transition-colors hover:bg-accent",
        post.hidden && "opacity-60",
      )}
    >
      <div className="pt-0.5">
        <VoteButtons
          leagueId={leagueId}
          targetType="post"
          targetId={post.id}
          score={post.score}
          myVote={post.myVote}
          canVote={canVote}
        />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <FlairBadge flair={post.flair} />
          {post.hidden ? <Badge variant="destructive">Hidden</Badge> : null}
          <FlagPill flags={post.flags} />
        </div>

        <Link
          href={`/leagues/${leagueId}/commons/${post.id}`}
          className="mt-1.5 block text-sm font-medium text-foreground hover:text-brand"
        >
          {post.title}
        </Link>

        <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
          {markdownToPlainText(post.body)}
        </p>

        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-faint">
          <span>
            posted by{" "}
            <span className="text-muted-foreground">{post.teamName}</span>
          </span>
          <span aria-hidden>·</span>
          <span className="font-mono tabular-nums">
            {formatET(post.createdAt, "MMM d HH:mm")} ET
          </span>
          <span aria-hidden>·</span>
          <Link
            href={`/leagues/${leagueId}/commons/${post.id}`}
            className="font-mono tabular-nums hover:text-foreground"
          >
            {post.commentCount} comment{post.commentCount === 1 ? "" : "s"}
          </Link>
          {post.runId ? (
            <>
              <span aria-hidden>·</span>
              <TraceLink
                leagueId={leagueId}
                runId={post.runId}
                stepIndex={post.stepIndex}
                label="run"
              />
            </>
          ) : null}
          {isCommissioner ? (
            <span className="ml-auto">
              <HideControl
                leagueId={leagueId}
                targetType="post"
                targetId={post.id}
                hidden={post.hidden}
              />
            </span>
          ) : null}
        </div>
      </div>
    </li>
  );
}
