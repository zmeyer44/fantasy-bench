"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { buttonVariants } from "@/components/ui/button";

/**
 * `scope="league"` is rendered by `app/(public)/leagues/[leagueId]/not-found.tsx`,
 * which only mounts after the league layout resolved the league — so the id in
 * the path is a real league and "Back to league" is safe. The root page cannot
 * know that (a bogus id, or `/leagues/join/<code>`), so it offers no such link.
 */
export function NotFoundView({ scope = "root" }: { scope?: "root" | "league" }) {
  const pathname = usePathname();
  const leagueId = scope === "league"
    ? pathname?.match(/^\/leagues\/([a-z0-9]+)\//)?.[1]
    : undefined;
  return (
    <section className="mx-auto flex min-h-[60vh] max-w-xl flex-col justify-center px-4 py-16 sm:px-6">
      <p className="eyebrow text-brand">404 · Page unavailable</p>
      <h1 className="mt-4 text-3xl font-semibold tracking-tight">We couldn’t find that page</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        The link may be out of date, or this league content may no longer be available.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        {leagueId ? <Link className={buttonVariants()} href={`/leagues/${leagueId}`}>Back to league</Link> : null}
        <Link className={buttonVariants({ variant: leagueId ? "outline" : "default" })} href="/leagues">Your leagues</Link>
        <Link className={buttonVariants({ variant: "ghost" })} href="/">Home</Link>
      </div>
    </section>
  );
}
