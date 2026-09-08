import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ConfigNav } from "@/components/config/config-nav";
import { DiffView } from "@/components/config/diff-view";
import { Card, CardBody, EmptyState, PageHeader } from "@/components/ui";
import { diffVersionRows, getConfigForTeam, getVersion } from "@/lib/services/config";
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

  const view = await getConfigForTeam(teamId).catch(() => null);
  if (!view || view.team.leagueId !== leagueId) notFound();

  const base = `/leagues/${leagueId}/teams/${teamId}/config/versions`;
  const aId = first(query.a);
  const bId = first(query.b);

  const [a, b] = await Promise.all([
    aId ? getVersion(aId) : Promise.resolve(null),
    bId ? getVersion(bId) : Promise.resolve(null),
  ]);

  const valid =
    a && b && view.versions.some((v) => v.id === a.id) && view.versions.some((v) => v.id === b.id);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href={base} className="hover:text-ink">
            {view.team.name} · history
          </Link>
        }
        title="Compare versions"
        description="Pick any two versions of this config."
      />

      <ConfigNav leagueId={leagueId} teamId={teamId} />

      <Card>
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <VersionColumn
            title="Base (a)"
            base={base}
            selectedId={a?.id ?? null}
            otherId={b?.id ?? null}
            side="a"
            versions={view.versions}
          />
          <VersionColumn
            title="Compare (b)"
            base={base}
            selectedId={b?.id ?? null}
            otherId={a?.id ?? null}
            side="b"
            versions={view.versions}
          />
        </CardBody>
      </Card>

      {valid ? (
        <DiffView diff={diffVersionRows(a, b)} leagueId={leagueId} teamId={teamId} />
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
  versions: Array<{ id: string; versionNo: number; createdAt: Date; changeSummary: string | null }>;
}) {
  return (
    <div>
      <div className="eyebrow mb-2">{title}</div>
      <ul className="max-h-64 space-y-1 overflow-y-auto">
        {versions.map((v) => {
          const href =
            side === "a"
              ? `${base}/compare?a=${v.id}${otherId ? `&b=${otherId}` : ""}`
              : `${base}/compare?${otherId ? `a=${otherId}&` : ""}b=${v.id}`;
          const selected = v.id === selectedId;
          return (
            <li key={v.id}>
              <Link
                href={href}
                className={
                  selected
                    ? "flex items-baseline gap-2 rounded border border-accent/40 bg-accent-soft px-2 py-1 text-xs text-accent-strong"
                    : "flex items-baseline gap-2 rounded border border-line px-2 py-1 text-xs text-ink hover:bg-surface-muted"
                }
              >
                <span className="font-mono">v{v.versionNo}</span>
                <span className="text-ink-faint">{formatET(v.createdAt, "MMM d, HH:mm")}</span>
                <span className="truncate text-ink-muted">{v.changeSummary ?? ""}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
