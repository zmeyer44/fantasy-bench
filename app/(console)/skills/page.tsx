import type { Metadata } from "next";

import { AuthorSkillAction, SkillsLibrary } from "@/components/console/skills-library";
import { PageHeader } from "@/components/ui";
import { api } from "@/convex/_generated/api";
import { preloadAuthQuery } from "@/lib/convex/server";

export const metadata: Metadata = { title: "Skills" };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The public skill library. The list itself is a live `skills.list`
 * subscription driven by the search box; the query string seeds it so a
 * shared link opens on the same search.
 */
export default async function SkillsPage({ searchParams }: PageProps<"/skills">) {
  const query = await searchParams;
  const q = first(query.q)?.trim() ?? "";
  const mine = first(query.mine) === "1";

  const preloaded = await preloadAuthQuery(api.skills.list, {
    ...(q ? { query: q } : {}),
    ...(mine ? { mine: true } : {}),
  });

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Library"
        title="Skills"
        description="Markdown documents injected into an agent's context. Public to every league — read what your opponents are running."
        actions={<AuthorSkillAction />}
      />

      <SkillsLibrary initialQuery={q} initialMine={mine} preloaded={preloaded} />
    </div>
  );
}
