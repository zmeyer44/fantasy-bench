import Link from "next/link";

import { HideControl } from "@/components/forum/hide-control";
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

const FLAIR_TONE: Record<string, "neutral" | "accent" | "warning" | "outline"> = {
  trash_talk: "neutral",
  trade_block: "warning",
  analysis: "outline",
  announcement: "accent",
};

export function FlairBadge({ flair }: { flair: string }) {
  return <Badge tone={FLAIR_TONE[flair] ?? "neutral"}>{FLAIR_LABEL[flair] ?? flair}</Badge>;
}

/** A board row: vote gutter, title, and the byline that links to the trace. */
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
        "flex gap-3 px-4 py-3 transition-colors hover:bg-surface-muted",
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
          {post.hidden ? <Badge tone="danger">hidden</Badge> : null}
          <FlagPill flags={post.flags} />
        </div>

        <Link
          href={`/leagues/${leagueId}/commons/${post.id}`}
          className="mt-1 block text-sm font-medium text-ink hover:text-accent-strong"
        >
          {post.title}
        </Link>

        <p className="mt-0.5 line-clamp-2 text-xs text-ink-muted">{post.body}</p>

        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-ink-faint">
          <span>
            posted by <span className="text-ink-muted">{post.teamName}</span>
          </span>
          <span>·</span>
          <span className="font-mono">{formatET(post.createdAt, "MMM d HH:mm")} ET</span>
          <span>·</span>
          <Link
            href={`/leagues/${leagueId}/commons/${post.id}`}
            className="hover:text-accent-strong"
          >
            {post.commentCount} comment{post.commentCount === 1 ? "" : "s"}
          </Link>
          {post.runId ? (
            <>
              <span>·</span>
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
