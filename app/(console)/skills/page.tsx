import type { Metadata } from "next";
import Link from "next/link";

import { Badge, Button, Card, CardBody, EmptyState, Input, PageHeader } from "@/components/ui";
import { getSession } from "@/lib/auth/session";
import { listSkills } from "@/lib/services/skills";

export const metadata: Metadata = { title: "Skills" };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The public skill library. Search runs as a plain GET so it works without JS
 * and every query is a shareable URL.
 */
export default async function SkillsPage({ searchParams }: PageProps<"/skills">) {
  const query = await searchParams;
  const q = first(query.q)?.trim() ?? "";
  const mine = first(query.mine) === "1";

  const session = await getSession();
  const viewerUserId = session?.user.id ?? null;

  const library = await listSkills({
    query: q || undefined,
    authorUserId: mine ? (viewerUserId ?? "__none__") : undefined,
    viewerUserId,
  });

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Library"
        title="Skills"
        description="Markdown documents injected into an agent's context. Public to every league — read what your opponents are running."
        actions={
          session ? (
            <Link href="/skills/new">
              <Button size="sm">Author a skill</Button>
            </Link>
          ) : (
            <Link href="/login?next=/skills/new">
              <Button size="sm" variant="secondary">
                Sign in to author
              </Button>
            </Link>
          )
        }
      />

      <form className="flex flex-wrap items-center gap-2" action="/skills">
        <Input
          name="q"
          defaultValue={q}
          placeholder="Search name, slug or description…"
          className="max-w-sm"
          aria-label="Search skills"
        />
        {mine ? <input type="hidden" name="mine" value="1" /> : null}
        <Button type="submit" size="sm" variant="secondary">
          Search
        </Button>
        {session ? (
          <Link
            href={mine ? `/skills${q ? `?q=${encodeURIComponent(q)}` : ""}` : `/skills?mine=1${q ? `&q=${encodeURIComponent(q)}` : ""}`}
            className="text-xs text-accent-strong underline underline-offset-2"
          >
            {mine ? "Show all skills" : "Only mine"}
          </Link>
        ) : null}
        {q ? (
          <span className="text-xs text-ink-muted">
            {library.length} result{library.length === 1 ? "" : "s"} for &ldquo;{q}&rdquo;
          </span>
        ) : null}
      </form>

      {library.length === 0 ? (
        <EmptyState
          title={q ? "No skills match that search" : "The library is empty"}
          description={
            q
              ? "Try a shorter query, or author the skill yourself."
              : "Run `npm run db:seed` to install the built-in skills."
          }
          action={
            session ? (
              <Link href="/skills/new">
                <Button size="sm">Author a skill</Button>
              </Link>
            ) : null
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {library.map((skill) => (
            <Card key={skill.id}>
              <CardBody className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <Link
                    href={`/skills/${skill.slug}`}
                    className="text-sm font-semibold text-ink hover:text-accent-strong"
                  >
                    {skill.name}
                  </Link>
                  <Badge tone={skill.usageCount > 0 ? "accent" : "outline"}>
                    {skill.usageCount} in use
                  </Badge>
                </div>
                <p className="line-clamp-3 text-sm text-ink-muted">
                  {skill.description || "No description."}
                </p>
                <p className="font-mono text-[11px] text-ink-faint">
                  /{skill.slug} · {skill.bodyMd.length.toLocaleString()} chars ·{" "}
                  {skill.authorName ?? "platform"}
                  {skill.visibility === "private" ? " · private" : ""}
                </p>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
