import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ConfigNav } from "@/components/config/config-nav";
import { DiffView } from "@/components/config/diff-view";
import { readOrNull } from "@/components/league/convex-errors";
import { EmptyState, PageHeader, cn } from "@/components/ui";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { fetchAuthQuery } from "@/lib/convex/server";
import { formatET } from "@/lib/time";

export const metadata: Metadata = { title: "Compare config versions" };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Free-form comparison of any two versions of one team's config. */
export default async function CompareVersionsPage({
  params,
  searchParams,
}: PageProps<"/leagues/[leagueId]/teams/[teamId]/config/versions/compare">) {
  const { leagueId, teamId } = await params;
  const query = await searchParams;

  const view = await readOrNull(() =>
    fetchAuthQuery(api.configs.versions, {
      leagueId: leagueId as Id<"leagues">,
      teamId: teamId as Id<"teams">,
    }),
  );
  if (!view) notFound();

  const base = `/leagues/${leagueId}/teams/${teamId}/config/versions`;
  const aId = first(query.a);
  const bId = first(query.b);
  // Only versions past their cooldown can be diffed by this viewer.
  const versions = view.versions.filter((v) => !v.redacted);
  const known = new Set(versions.map((v) => v._id as string));

  // `configs.diff` re-checks the league; the id pair is validated here so a
  // bookmarked link to another team's version renders the picker, not an error.
  const diff =
    aId && bId && known.has(aId) && known.has(bId)
      ? await fetchAuthQuery(api.configs.diff, {
          leagueId: leagueId as Id<"leagues">,
          a: aId as Id<"config_versions">,
          b: bId as Id<"config_versions">,
        })
      : null;

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={
          <Link href={base} className="transition-colors hover:text-foreground">
            {view.team.name} · history
          </Link>
        }
        title="Compare versions"
        description="Pick any two versions of this config."
      />

      <ConfigNav leagueId={leagueId} teamId={teamId} />

      <div className="grid gap-6 sm:grid-cols-2">
        <VersionColumn
          title="Base (a)"
          base={base}
          selectedId={diff ? (aId ?? null) : null}
          otherId={bId && known.has(bId) ? bId : null}
          side="a"
          versions={versions}
        />
        <VersionColumn
          title="Compare (b)"
          base={base}
          selectedId={diff ? (bId ?? null) : null}
          otherId={aId && known.has(aId) ? aId : null}
          side="b"
          versions={versions}
        />
      </div>

      {diff ? (
        <DiffView diff={diff} leagueId={leagueId} teamId={teamId} />
      ) : (
        <EmptyState
          title="Pick two versions"
          description="Choose a base and a comparison above. Both must belong to this team's config."
        />
      )}
    </div>
  );
}

function VersionColumn({
  title,
  base,
  side,
  selectedId,
  otherId,
  versions,
}: {
  title: string;
  base: string;
  side: "a" | "b";
  selectedId: string | null;
  otherId: string | null;
  versions: Array<{
    _id: string;
    _creationTime: number;
    versionNo: number;
    createdAt?: number;
    changeSummary?: string;
  }>;
}) {
  return (
    <div>
      <div className="eyebrow border-b border-border pb-3">{title}</div>
      <ul className="max-h-64 divide-y divide-border overflow-y-auto">
        {versions.map((v) => {
          const href =
            side === "a"
              ? `${base}/compare?a=${v._id}${otherId ? `&b=${otherId}` : ""}`
              : `${base}/compare?${otherId ? `a=${otherId}&` : ""}b=${v._id}`;
          const selected = v._id === selectedId;
          return (
            <li key={v._id}>
              <Link
                href={href}
                aria-current={selected ? "true" : undefined}
                className={cn(
                  "flex items-baseline gap-2.5 px-2 py-2 text-sm transition-colors",
                  selected
                    ? "bg-brand-soft text-brand"
                    : "text-foreground hover:bg-accent",
                )}
              >
                <span className="font-mono text-xs tabular-nums">v{v.versionNo}</span>
                <span className="font-mono text-xs text-ink-faint">
                  {formatET(v.createdAt ?? v._creationTime, "MMM d, HH:mm")}
                </span>
                <span className="truncate text-muted-foreground">{v.changeSummary ?? ""}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
