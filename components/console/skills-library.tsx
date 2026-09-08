"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { usePreloadedQuery, useQuery, type Preloaded } from "convex/react";

import { api } from "@/convex/_generated/api";
import { Badge, Button, Card, CardBody, EmptyState, Input } from "@/components/ui";

const DEBOUNCE_MS = 250;

/**
 * The skill library index.
 *
 * The search box drives the `skills.list` subscription directly (debounced), so
 * results update as you type and a newly published skill appears without a
 * reload. The URL is kept in step so a search is still shareable.
 */
export function SkillsLibrary({
  initialQuery,
  initialMine,
  preloaded,
}: {
  initialQuery: string;
  initialMine: boolean;
  /** The server's page for the initial args — the first paint, then live. */
  preloaded: Preloaded<typeof api.skills.list>;
}) {
  const router = useRouter();
  const pathname = usePathname();

  const [input, setInput] = useState(initialQuery);
  const [term, setTerm] = useState(initialQuery);
  const [mine, setMine] = useState(initialMine);

  useEffect(() => {
    const timer = setTimeout(() => setTerm(input.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input]);

  // Shareable URL, without re-rendering the server component on every keystroke.
  useEffect(() => {
    const params = new URLSearchParams();
    if (term) params.set("q", term);
    if (mine) params.set("mine", "1");
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [term, mine, pathname, router]);

  const viewer = useQuery(api.users.me, {});
  const signedIn = Boolean(viewer);

  // The preloaded subscription covers the args the page was rendered with; a
  // changed search or filter switches to its own live query.
  const initialArgs = term === initialQuery && mine === initialMine;
  const preloadedLibrary = usePreloadedQuery(preloaded);
  const searched = useQuery(
    api.skills.list,
    initialArgs ? "skip" : { ...(term ? { query: term } : {}), ...(mine ? { mine: true } : {}) },
  );
  const library = initialArgs ? preloadedLibrary : searched;

  const skills = library ?? [];

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          name="q"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Search name, slug or description…"
          className="max-w-sm"
          aria-label="Search skills"
        />
        {signedIn ? (
          <button
            type="button"
            onClick={() => setMine((value) => !value)}
            className="text-xs text-accent-strong underline underline-offset-2"
          >
            {mine ? "Show all skills" : "Only mine"}
          </button>
        ) : null}
        {term ? (
          <span className="text-xs text-ink-muted">
            {library === undefined
              ? "Searching…"
              : `${skills.length} result${skills.length === 1 ? "" : "s"} for “${term}”`}
          </span>
        ) : null}
      </div>

      {library === undefined ? (
        <p className="text-sm text-ink-muted">Loading the library…</p>
      ) : skills.length === 0 ? (
        <EmptyState
          title={term ? "No skills match that search" : "The library is empty"}
          description={
            term
              ? "Try a shorter query, or author the skill yourself."
              : "Run the Convex seed to install the built-in skills."
          }
          action={
            signedIn ? (
              <Link href="/skills/new">
                <Button size="sm">Author a skill</Button>
              </Link>
            ) : null
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {skills.map((skill) => (
            <Card key={skill._id}>
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
    </>
  );
}

/** "Author a skill" / "Sign in to author", gated on the live viewer. */
export function AuthorSkillAction() {
  const viewer = useQuery(api.users.me, {});
  if (viewer === undefined) return null;
  return viewer ? (
    <Link href="/skills/new">
      <Button size="sm">Author a skill</Button>
    </Link>
  ) : (
    <Link href="/login?next=/skills/new">
      <Button size="sm" variant="secondary">
        Sign in to author
      </Button>
    </Link>
  );
}
