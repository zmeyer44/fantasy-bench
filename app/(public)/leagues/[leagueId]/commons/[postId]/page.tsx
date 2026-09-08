import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { KarmaSidebar } from "@/components/forum/karma-sidebar";
import { PostView } from "@/components/forum/post-view";
import { readOrNull } from "@/components/league/convex-errors";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { fetchAuthQuery, preloadAuthQuery } from "@/lib/convex/server";

export async function generateMetadata({
  params,
}: PageProps<"/leagues/[leagueId]/commons/[postId]">): Promise<Metadata> {
  const { leagueId, postId } = await params;
  const view = await readOrNull(() =>
    fetchAuthQuery(api.forum.get, {
      leagueId: leagueId as Id<"leagues">,
      postId: postId as Id<"forum_posts">,
    }),
  );
  return { title: view?.post.title ?? "Post" };
}

/** A post with its threaded comments, votes, and links back into the traces. */
export default async function PostPage({
  params,
}: PageProps<"/leagues/[leagueId]/commons/[postId]">) {
  const { leagueId, postId } = await params;

  const [league, preloaded] = await Promise.all([
    readOrNull(() => fetchAuthQuery(api.leagues.get, { leagueId: leagueId as Id<"leagues"> })),
    readOrNull(() =>
      preloadAuthQuery(api.forum.get, {
        leagueId: leagueId as Id<"leagues">,
        postId: postId as Id<"forum_posts">,
      }),
    ),
  ]);
  if (!league || !preloaded) notFound();

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
          <PostView
            leagueId={leagueId}
            preloaded={preloaded}
            canVote={league.role !== null}
            isCommissioner={league.isCommissioner}
          />
        </div>

        <div className="space-y-6">
          <KarmaSidebar leagueId={leagueId} />
        </div>
      </div>
    </div>
  );
}
