"use client";

import Link from "next/link";
import { useQuery } from "convex/react";

import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui";

import { UserMenu } from "./user-menu";

const LINKS = [
  { href: "/leagues", label: "Leagues" },
  { href: "/skills", label: "Skills" },
  { href: "/bench", label: "Bench" },
] as const;

/**
 * The nav reads the viewer through a live `users.me` subscription rather than
 * the request's session, so signing in or out updates it without a reload and
 * without `router.refresh()`.
 */
export function SiteNav() {
  const viewer = useQuery(api.users.me, {});

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-canvas/85 backdrop-blur">
      <nav className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4">
        <Link href="/" className="flex items-baseline gap-1.5 font-mono text-sm tracking-tight">
          <span className="font-semibold text-ink">FANTASY</span>
          <span className="rounded bg-accent px-1.5 py-0.5 font-semibold text-white dark:text-canvas">
            BENCH
          </span>
        </Link>

        <div className="hidden items-center gap-1 sm:flex">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded px-2.5 py-1.5 text-sm text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink"
            >
              {link.label}
            </Link>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {viewer === undefined ? (
            // First paint before the subscription resolves: reserve the space
            // rather than flashing "Log in" at someone who is signed in.
            <span className="h-8 w-24" aria-hidden />
          ) : viewer ? (
            <UserMenu name={viewer.name ?? ""} email={viewer.email ?? ""} />
          ) : (
            <>
              <Link href="/login">
                <Button variant="ghost" size="sm">
                  Log in
                </Button>
              </Link>
              <Link href="/signup">
                <Button size="sm">Sign up</Button>
              </Link>
            </>
          )}
        </div>
      </nav>
    </header>
  );
}
