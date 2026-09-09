"use client";

import { ArrowUpRight, Menu } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import styles from "@/components/landing/hero.module.css";
import { usePathname } from "next/navigation";
import { useQuery } from "convex/react";

import { LogoMark } from "@/components/brand/logo";
import {
  Button,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  cn,
} from "@/components/ui";
import { api } from "@/convex/_generated/api";

import { leagueIdFromPathname, leagueNavEntries } from "./nav/league-sections";
import { LeagueSwitcher } from "./nav/league-switcher";
import { LeagueTabs, LeagueTabsRow } from "./nav/league-tabs";
import { UserMenu } from "./user-menu";

/** Account-level sections, shown when the viewer is not inside a league. */
const CONSOLE_LINKS = [
  { href: "/leagues", label: "Leagues" },
  { href: "/skills", label: "Skills" },
  { href: "/bench", label: "Bench" },
] as const;

const LANDING_LINKS = [
  { href: "/leagues", label: "League" },
  { href: "/#how-it-works", label: "Docs" },
  { href: "/bench", label: "Leaderboard" },
] as const;

/**
 * One bar for the whole product. Inside a league the bar carries the league
 * itself — a switcher where the page header used to be, then the league's
 * sections as tabs — so pages start with their content. Elsewhere it carries
 * the console sections.
 *
 * The nav reads the viewer through a live `users.me` subscription rather than
 * the request's session, so signing in or out updates it without a reload and
 * without `router.refresh()`.
 */
export function SiteNav() {
  const viewer = useQuery(api.users.me, {});
  const pathname = usePathname();
  const isLanding = pathname === "/";
  const [menuOpen, setMenuOpen] = useState(false);

  // `navContext` never throws, so a league the viewer cannot read (or a stale
  // bookmark that is not a Convex id) resolves to `null` and the bar falls back
  // to the console links while the page below renders its 404.
  const leagueId = leagueIdFromPathname(pathname);
  const league = useQuery(api.leagues.navContext, leagueId ? { leagueId } : "skip");
  const inLeague = leagueId !== null && Boolean(league);
  const leagueEntries = league
    ? leagueNavEntries(
        { leagueId: league.leagueId, isCommissioner: league.isCommissioner, myTeamId: league.viewerTeamId },
        pathname,
      )
    : [];

  const links = isLanding ? LANDING_LINKS : CONSOLE_LINKS;

  return (
    <header className={cn("sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur supports-backdrop-filter:bg-background/75", isLanding && styles.header)}>
      <nav aria-label="Main navigation" className={cn("mx-auto flex h-14 max-w-7xl items-center gap-4 px-4 sm:px-6", isLanding && styles.nav)}>
        <Link href="/" className={cn("flex shrink-0 items-center gap-2.5 text-foreground", isLanding && styles.brandLink)} aria-label="Fantasy Bench home">
          <LogoMark className={cn("size-7", isLanding && styles.brandLogo)} />
          <span className={cn("display text-[13px] tracking-[0.12em]", inLeague && "hidden xl:inline", isLanding && styles.brandName)}>
            Fantasy Bench
          </span>
        </Link>

        {inLeague && league ? (
          <>
            <span aria-hidden className="select-none text-lg font-light text-border">/</span>
            <LeagueSwitcher
              current={{
                leagueId: league.leagueId,
                name: league.name,
                season: league.season,
                status: league.status,
                role: league.role,
              }}
              leagues={(viewer?.memberships ?? []).map((m) => ({
                leagueId: m.leagueId,
                name: m.leagueName,
                role: m.role,
              }))}
              className="max-w-40 sm:max-w-56"
            />
            <LeagueTabs entries={leagueEntries} className="hidden lg:flex" />
          </>
        ) : (
          <div className={cn("hidden items-center gap-1 md:flex", isLanding && styles.navLinks)}>
            {links.map((link) => {
              const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "eyebrow rounded-md px-2.5 py-2 transition-colors hover:text-foreground",
                    active && "text-foreground",
                  )}
                >
                  {link.label}
                </Link>
              );
            })}
          </div>
        )}

        <div className={cn("ml-auto flex items-center gap-2", isLanding && styles.account)}>
          {viewer === undefined ? (
            // First paint before the subscription resolves: reserve the space
            // rather than flashing "Log in" at someone who is signed in.
            <span className="h-8 w-40" aria-hidden />
          ) : viewer ? (
            <UserMenu name={viewer.name ?? ""} email={viewer.email ?? ""} />
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="eyebrow hidden hover:text-foreground sm:inline-flex"
                role="link" render={<Link href="/login" />}
              >
                Log in
              </Button>
              <Button variant="brand" size="sm" role="link" render={<Link href="/signup" />}>
                Get started
                <ArrowUpRight data-icon="inline-end" />
              </Button>
            </>
          )}

          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger
              render={
                <Button variant="ghost" size="icon-sm" className={cn("md:hidden", isLanding && styles.menuTrigger)} aria-label="Open menu" />
              }
            >
              <Menu />
            </SheetTrigger>
            <SheetContent side="right" className="w-72">
              <SheetHeader>
                <SheetTitle className="display text-sm tracking-[0.12em]">Fantasy Bench</SheetTitle>
                <SheetDescription className="sr-only">Site navigation</SheetDescription>
              </SheetHeader>
              <div className="flex flex-col gap-1 px-4">
                {CONSOLE_LINKS.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    onClick={() => setMenuOpen(false)}
                    className="eyebrow rounded-md px-2 py-3 hover:bg-accent hover:text-foreground"
                  >
                    {link.label}
                  </Link>
                ))}
                {viewer ? null : (
                  <Link href="/login" onClick={() => setMenuOpen(false)} className="eyebrow rounded-md px-2 py-3 hover:bg-accent hover:text-foreground">
                    Log in
                  </Link>
                )}
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </nav>

      {inLeague ? (
        <div className="border-t border-border lg:hidden">
          <LeagueTabsRow entries={leagueEntries} className="mx-auto max-w-7xl px-4 sm:px-6" />
        </div>
      ) : null}
    </header>
  );
}
