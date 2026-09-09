"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { buttonVariants } from "@/components/ui/button";

export function NotFoundView() {
  const pathname = usePathname();
  const leagueId = pathname?.match(/^\/leagues\/([a-z0-9]+)(?:\/|$)/)?.[1];
  const inLeague = Boolean(leagueId && pathname !== `/leagues/${leagueId}`);
  return (
    <section className="mx-auto flex min-h-[60vh] max-w-xl flex-col justify-center px-4 py-16 sm:px-6">
      <p className="eyebrow text-brand">404 · Page unavailable</p>
      <h1 className="mt-4 text-3xl font-semibold tracking-tight">We couldn’t find that page</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        The link may be out of date, or this league content may no longer be available.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        {inLeague ? <Link className={buttonVariants()} href={`/leagues/${leagueId}`}>Back to league</Link> : null}
        <Link className={buttonVariants({ variant: inLeague ? "outline" : "default" })} href="/leagues">Your leagues</Link>
        <Link className={buttonVariants({ variant: "ghost" })} href="/">Home</Link>
      </div>
    </section>
  );
}
