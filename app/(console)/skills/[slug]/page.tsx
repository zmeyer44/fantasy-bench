import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ForkSkillButton } from "@/components/config/fork-button";
import { Markdown } from "@/components/config/markdown";
import { readOrNull } from "@/components/league/convex-errors";
import { Badge, Button, PageHeader } from "@/components/ui";
import { api } from "@/convex/_generated/api";
import { fetchAuthQuery } from "@/lib/convex/server";
import { getViewer } from "@/lib/convex/viewer";
import { formatET } from "@/lib/time";

/** `skills.get` throws FORBIDDEN on someone else's private skill — that is a 404 here. */
async function loadSkill(slug: string) {
  return readOrNull(() => fetchAuthQuery(api.skills.get, { slug }));
}

export async function generateMetadata({ params }: PageProps<"/skills/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const skill = await loadSkill(slug);
  return { title: skill?.name ?? "Skill" };
}

export default async function SkillPage({ params }: PageProps<"/skills/[slug]">) {
  const { slug } = await params;
  const [skill, viewer] = await Promise.all([loadSkill(slug), getViewer()]);
  if (!skill) notFound();

  const isAuthor = Boolean(viewer) && skill.authorUserId === viewer!.userId;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <PageHeader
        eyebrow={
          <Link href="/skills" className="transition-colors hover:text-foreground">
            Library
          </Link>
        }
        title={skill.name}
        description={skill.description || undefined}
        actions={
          <div className="flex items-center gap-2">
            <ForkSkillButton slug={skill.slug} signedIn={Boolean(viewer)} />
            {isAuthor ? (
              <Button size="sm" render={<Link href={`/skills/${skill.slug}/edit`} />}>
                Edit
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={skill.usageCount > 0 ? "success" : "outline"}>
          {skill.usageCount} current config{skill.usageCount === 1 ? "" : "s"}
        </Badge>
        <Badge variant="outline">{skill.visibility}</Badge>
        <Badge variant="outline">{skill.bodyMd.length.toLocaleString()} chars</Badge>
        <span className="font-mono text-xs text-ink-faint">
          by {skill.authorName ?? "platform"} · updated{" "}
          {formatET(skill.updatedAt, "MMM d, yyyy")}
        </span>
      </div>

      {skill.forkedFrom ? (
        <p className="text-sm text-muted-foreground">
          Forked from{" "}
          <Link
            href={`/skills/${skill.forkedFrom.slug}`}
            className="text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-brand"
          >
            {skill.forkedFrom.name}
          </Link>
          .
        </p>
      ) : null}

      <section className="space-y-3">
        <div className="border-b border-border pb-3">
          <h2 className="eyebrow text-foreground">How to attach it</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Open your team&apos;s config editor, choose Skills → Attach from library, and search for
          this name. Skills are attached by id, so if {skill.authorName ?? "the author"} edits this
          document your agent reads the new text on its next run — no config version needed. Fork it
          if you want a copy that only you can change.
        </p>
      </section>

      <section className="space-y-4">
        <div className="border-b border-border pb-3">
          <h2 className="eyebrow text-foreground">Body</h2>
        </div>
        <Markdown>{skill.bodyMd}</Markdown>
      </section>

      {skill.forks.length > 0 ? (
        <section className="space-y-3">
          <div className="border-b border-border pb-3">
            <h2 className="eyebrow text-foreground">
              {skill.forks.length} fork{skill.forks.length === 1 ? "" : "s"}
            </h2>
          </div>
          <div className="flex flex-wrap gap-2">
            {skill.forks.map((fork) => (
              <Link
                key={fork._id}
                href={`/skills/${fork.slug}`}
                className="rounded-sm border border-border px-2.5 py-1 text-sm text-foreground transition-colors hover:bg-accent"
              >
                {fork.name}
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
