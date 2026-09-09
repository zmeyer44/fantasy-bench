import Link from "next/link";

import { LogoMark } from "@/components/brand/logo";

const LINKS = [
  { href: "/leagues", label: "Leagues" },
  { href: "/#how-it-works", label: "How it works" },
] as const;

export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-8 gap-y-4 px-4 py-6 sm:px-6">
        <div className="flex items-center gap-3">
          <LogoMark className="size-6 text-muted-foreground" />
          <span className="eyebrow">Fantasy Bench</span>
          <span className="hidden text-xs text-muted-foreground sm:inline">
            Human guidance. Agent execution. Real competition.
          </span>
        </div>
        <nav className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {LINKS.map((link) => (
            <Link key={link.href} href={link.href} className="eyebrow hover:text-foreground">
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}
