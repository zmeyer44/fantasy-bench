"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { usePreloadedQuery, useQuery, type Preloaded } from "convex/react";

import { api } from "@/convex/_generated/api";
import { Badge, Button, EmptyState, Input, Skeleton } from "@/components/ui";

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
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3 border-b border-border pb-5">
        <Input
          name="q"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Search name, slug or description…"
          className="max-w-sm"
          aria-label="Search skills"
        />
        {signedIn ? (
          <Button
            type="button"
            size="sm"
            variant={mine ? "secondary" : "ghost"}
            aria-pressed={mine}
            onClick={() => setMine((value) => !value)}
          >
            {mine ? "Showing yours" : "Only mine"}
          </Button>
        ) : null}
        {term ? (
          <span className="text-sm text-muted-foreground">
            {library === undefined
              ? "Searching…"
              : `${skills.length} result${skills.length === 1 ? "" : "s"} for “${term}”`}
          </span>
        ) : null}
      </div>

      {library === undefined ? (
        <div className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="space-y-3 bg-background p-4">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-24" />
            </div>
          ))}
        </div>
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
              <Button size="sm" render={<Link href="/skills/new" />}>
                Author a skill
              </Button>
            ) : null
          }
        />
      ) : (
        // A hairline grid rather than a deck of cards: the rows read as one
        // table of the library, not as six separate objects.
        <ul className="grid gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
          {skills.map((skill) => (
            <li
              key={skill._id}
              className="flex min-w-0 flex-col gap-2.5 bg-background p-4 transition-colors hover:bg-card"
            >
              <div className="flex items-start justify-between gap-3">
                <Link
                  href={`/skills/${skill.slug}`}
                  className="truncate text-sm font-medium text-foreground transition-colors hover:text-brand"
                >
                  {skill.name}
                </Link>
                <Badge variant={skill.usageCount > 0 ? "success" : "outline"}>
                  {skill.usageCount} in use
                </Badge>
              </div>
              <p className="line-clamp-3 text-sm text-muted-foreground">
                {skill.description || "No description."}
              </p>
              <p className="mt-auto font-mono text-xs text-ink-faint">
                /{skill.slug} · {skill.bodyMd.length.toLocaleString()} chars ·{" "}
                {skill.authorName ?? "platform"}
                {skill.visibility === "private" ? " · private" : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** "Author a skill" / "Sign in to author", gated on the live viewer. */
export function AuthorSkillAction() {
  const viewer = useQuery(api.users.me, {});
  if (viewer === undefined) return null;
  return viewer ? (
    <Button size="sm" render={<Link href="/skills/new" />}>
      Author a skill
    </Button>
  ) : (
    <Button size="sm" variant="outline" render={<Link href="/login?next=/skills/new" />}>
      Sign in to author
    </Button>
  );
}
