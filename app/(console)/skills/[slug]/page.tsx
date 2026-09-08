import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ForkSkillButton } from "@/components/config/fork-button";
import { Markdown } from "@/components/config/markdown";
import { readOrNull } from "@/components/league/convex-errors";
import { Badge, Button, Card, CardBody, CardHeader, PageHeader } from "@/components/ui";
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
          <Link href="/skills" className="hover:text-ink">
            Library
          </Link>
        }
        title={skill.name}
        description={skill.description || undefined}
        actions={
          <div className="flex items-center gap-2">
            <ForkSkillButton slug={skill.slug} signedIn={Boolean(viewer)} />
            {isAuthor ? (
              <Link href={`/skills/${skill.slug}/edit`}>
                <Button size="sm">Edit</Button>
              </Link>
            ) : null}
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={skill.usageCount > 0 ? "accent" : "outline"}>
          {skill.usageCount} current config{skill.usageCount === 1 ? "" : "s"}
        </Badge>
        <Badge tone="outline">{skill.visibility}</Badge>
        <Badge tone="outline">{skill.bodyMd.length.toLocaleString()} chars</Badge>
        <span className="font-mono text-[11px] text-ink-faint">
          by {skill.authorName ?? "platform"} · updated{" "}
          {formatET(skill.updatedAt, "MMM d, yyyy")}
        </span>
      </div>

      {skill.forkedFrom ? (
        <p className="text-xs text-ink-muted">
          Forked from{" "}
          <Link
            href={`/skills/${skill.forkedFrom.slug}`}
            className="text-accent-strong underline underline-offset-2"
          >
            {skill.forkedFrom.name}
          </Link>
          .
        </p>
      ) : null}

      <Card>
        <CardHeader
          title="How to attach it"
          description="Open your team's config editor, choose Skills → Attach from library, and search for this name."
        />
        <CardBody className="text-sm text-ink-muted">
          Skills are attached by id, so if {skill.authorName ?? "the author"} edits this document
          your agent reads the new text on its next run — no config version needed. Fork it if you
          want a copy that only you can change.
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <Markdown>{skill.bodyMd}</Markdown>
        </CardBody>
      </Card>

      {skill.forks.length > 0 ? (
        <Card>
          <CardHeader title={`${skill.forks.length} fork${skill.forks.length === 1 ? "" : "s"}`} />
          <CardBody className="flex flex-wrap gap-2">
            {skill.forks.map((fork) => (
              <Link
                key={fork._id}
                href={`/skills/${fork.slug}`}
                className="rounded border border-line px-2 py-1 text-xs text-ink hover:bg-surface-muted"
              >
                {fork.name}
              </Link>
            ))}
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
