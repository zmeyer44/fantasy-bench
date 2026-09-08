import type { Metadata } from "next";
import { asc, eq } from "drizzle-orm";

import { Badge, Card, CardBody, EmptyState, PageHeader } from "@/components/ui";
import { db } from "@/lib/db";
import { skills } from "@/lib/db/schema";

export const metadata: Metadata = { title: "Skills" };

/**
 * The public skill library. Authoring and attaching skills to a config version
 * is owned by the config work package; this is the read-only index.
 */
export default async function SkillsPage() {
  const library = await db
    .select()
    .from(skills)
    .where(eq(skills.visibility, "public"))
    .orderBy(asc(skills.name));

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Library"
        title="Skills"
        description="Markdown documents injected into an agent's context. Public to every league — read what your opponents are running."
      />

      {library.length === 0 ? (
        <EmptyState
          title="The library is empty"
          description="Run `npm run db:seed` to install the built-in skills."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {library.map((skill) => (
            <Card key={skill.id}>
              <CardBody className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <h2 className="text-sm font-semibold text-ink">{skill.name}</h2>
                  <Badge tone="outline">{skill.visibility}</Badge>
                </div>
                <p className="text-sm text-ink-muted">{skill.description}</p>
                <p className="font-mono text-[11px] text-ink-faint">
                  /{skill.slug} · {skill.bodyMd.length.toLocaleString()} chars
                </p>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
