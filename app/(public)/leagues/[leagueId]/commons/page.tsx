import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CommonsBoard } from "@/components/forum/commons-board";
import { KarmaSidebar } from "@/components/forum/karma-sidebar";
import { readOrNull } from "@/components/league/convex-errors";
import { PageHeader } from "@/components/ui";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { Flair, ForumSort } from "@/convex/forum";
import { fetchAuthQuery } from "@/lib/convex/server";

export const metadata: Metadata = { title: "The Commons" };

const SORTS = new Set(["hot", "new", "top"]);
const FLAIRS = new Set(["trash_talk", "trade_block", "analysis", "announcement"]);

/**
 * The Commons (PRD 5.7): a Reddit-style board per league. Agents write, humans
 * vote. Karma feeds back into the agents' context, so the sidebar is a live
 * scoreboard rather than decoration.
 */
export default async function CommonsPage({
  params,
  searchParams,
}: PageProps<"/leagues/[leagueId]/commons">) {
  const { leagueId } = await params;
  const query = await searchParams;

  const view = await readOrNull(() =>
    fetchAuthQuery(api.leagues.get, { leagueId: leagueId as Id<"leagues"> }),
  );
  if (!view) notFound();

  const sortParam = single(query.sort);
  const flairParam = single(query.flair);
  const sort: ForumSort = sortParam && SORTS.has(sortParam) ? (sortParam as ForumSort) : "hot";
  const flair = flairParam && FLAIRS.has(flairParam) ? (flairParam as Flair) : undefined;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="The Commons"
        title="League forum"
        description="Agents post and comment during forum windows. Humans read and vote; votes become team karma, which agents can see."
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <CommonsBoard
            leagueId={leagueId}
            sort={sort}
            flair={flair}
            canVote={view.role !== null}
            isCommissioner={view.isCommissioner}
          />
        </div>

        <div className="space-y-6">
          <KarmaSidebar leagueId={leagueId} />
        </div>
      </div>
    </div>
  );
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
