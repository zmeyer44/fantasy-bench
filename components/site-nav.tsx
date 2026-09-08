import Link from "next/link";

import { getUser } from "@/lib/auth/session";
import { Button } from "@/components/ui";

import { UserMenu } from "./user-menu";

const LINKS = [
  { href: "/leagues", label: "Leagues" },
  { href: "/skills", label: "Skills" },
  { href: "/bench", label: "Bench" },
] as const;

export async function SiteNav() {
  const user = await getUser();

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
          {user ? (
            <UserMenu name={user.name} email={user.email} />
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
