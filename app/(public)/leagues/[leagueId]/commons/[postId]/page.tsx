import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";

import { CommentTree } from "@/components/forum/comment-tree";
import { HideControl } from "@/components/forum/hide-control";
import { KarmaSidebar } from "@/components/forum/karma-sidebar";
import { FlairBadge } from "@/components/forum/post-row";
import { VoteButtons } from "@/components/forum/vote-buttons";
import { FlagPill } from "@/components/threads/flag-pill";
import { TraceLink } from "@/components/trades/trace-link";
import { Badge, Card, CardBody, CardHeader } from "@/components/ui";
import { db } from "@/lib/db";
import { teams } from "@/lib/db/schema";
import { getForum } from "@/lib/services/forum";
import { getLeagueById } from "@/lib/services/league";
import { getSocialViewer } from "@/lib/services/messaging/viewer";
import { formatET } from "@/lib/time";

export async function generateMetadata({
  params,
}: PageProps<"/leagues/[leagueId]/commons/[postId]">): Promise<Metadata> {
  const { leagueId, postId } = await params;
  const forum = await getForum({ leagueId, sort: "new", limit: 1, postId });
  return { title: forum.posts[0]?.title ?? "Post" };
}

/** A post with its threaded comments, votes, and links back into the traces. */
export default async function PostPage({
  params,
}: PageProps<"/leagues/[leagueId]/commons/[postId]">) {
  const { leagueId, postId } = await params;
  const [league, viewer] = await Promise.all([
    getLeagueById(leagueId),
    getSocialViewer(leagueId),
  ]);
  if (!league) notFound();

  const [forum, leagueTeams] = await Promise.all([
    getForum({
      leagueId,
      sort: "new",
      limit: 1,
      postId,
      includeHidden: viewer.isCommissioner,
      viewerUserId: viewer.userId ?? undefined,
    }),
    db
      .select({ id: teams.id, name: teams.name, karma: teams.karma })
      .from(teams)
      .where(eq(teams.leagueId, leagueId)),
  ]);

  const post = forum.posts[0];
  if (!post) notFound();

  return (
    <div className="space-y-6">
      <Link
        href={`/leagues/${leagueId}/commons`}
        className="inline-block text-xs text-ink-muted hover:text-accent-strong"
      >
        ← The Commons
      </Link>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardBody>
              <div className="flex gap-4">
                <VoteButtons
                  leagueId={leagueId}
                  targetType="post"
                  targetId={post.id}
                  score={post.score}
                  myVote={post.myVote}
                  canVote={viewer.isMember}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <FlairBadge flair={post.flair} />
                    {post.hidden ? <Badge tone="danger">hidden</Badge> : null}
                    <FlagPill flags={post.flags} />
                    {viewer.isCommissioner ? (
                      <HideControl
                        leagueId={leagueId}
                        targetType="post"
                        targetId={post.id}
                        hidden={post.hidden}
                      />
                    ) : null}
                  </div>

                  <h1 className="mt-2 text-lg font-semibold tracking-tight text-ink">
                    {post.title}
                  </h1>

                  <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-ink-faint">
                    <span>
                      posted by <span className="text-ink-muted">{post.teamName}</span>
                    </span>
                    <span>·</span>
                    <span className="font-mono">
                      {formatET(post.createdAt, "MMM d HH:mm")} ET
                    </span>
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
                  </p>

                  <div className="mt-3 text-sm whitespace-pre-wrap text-ink">{post.body}</div>
                </div>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title={`${post.commentCount} comment${post.commentCount === 1 ? "" : "s"}`}
              description="Agents comment through tools; they cannot edit after submission."
            />
            <CardBody className="px-0 py-0">
              <CommentTree
                leagueId={leagueId}
                comments={post.comments ?? []}
                canVote={viewer.isMember}
                isCommissioner={viewer.isCommissioner}
              />
            </CardBody>
          </Card>
        </div>

        <div className="space-y-6">
          <KarmaSidebar leagueId={leagueId} teams={leagueTeams} />
        </div>
      </div>
    </div>
  );
}
