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
import { GITHUB_URL, formatStars } from "@/lib/github";

import { leagueIdFromPathname, leagueNavEntries } from "./nav/league-sections";
import { LeagueSwitcher } from "./nav/league-switcher";
import { LeagueTabs, LeagueTabsRow } from "./nav/league-tabs";
import { UserMenu } from "./user-menu";

/** Account-level sections, shown when the viewer is not inside a league. */
const CONSOLE_LINKS = [{ href: "/leagues", label: "Leagues" }] as const;

const LANDING_LINKS = [
  { href: "/leagues", label: "League" },
  { href: "/#how-it-works", label: "Docs" },
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
export function SiteNav({ githubStars }: { githubStars: number | null }) {
  const viewer = useQuery(api.users.me, {});
  const pathname = usePathname();
  const isLanding = pathname === "/";
  const [menuOpen, setMenuOpen] = useState(false);

  // `navContext` never throws, so a league the viewer cannot read (or a stale
  // bookmark that is not a Convex id) resolves to `null` and the bar falls back
  // to the console links while the page below renders its 404.
  const leagueId = leagueIdFromPathname(pathname);
  const league = useQuery(
    api.leagues.navContext,
    leagueId ? { leagueId } : "skip",
  );
  const inLeague = leagueId !== null && Boolean(league);
  const leagueEntries = league
    ? leagueNavEntries(
        {
          leagueId: league.leagueId,
          isCommissioner: league.isCommissioner,
          myTeamId: league.viewerTeamId,
        },
        pathname,
      )
    : [];

  const links = isLanding ? LANDING_LINKS : CONSOLE_LINKS;
  // Signed-in CTA: a member goes straight to their league, everyone else to the
  // league list. Hidden inside a league, where the switcher already covers it.
  const homeLeagueId = viewer?.memberships[0]?.leagueId ?? null;

  return (
    <header
      className={cn(
        "sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur supports-backdrop-filter:bg-background/75",
        isLanding && styles.header,
      )}
    >
      <nav
        aria-label="Main navigation"
        className={cn(
          "mx-auto flex h-14 max-w-7xl items-center gap-4 px-4 sm:px-6",
          isLanding && styles.nav,
        )}
      >
        <Link
          href="/"
          className={cn(
            "flex shrink-0 items-center gap-2.5 text-foreground",
            isLanding && styles.brandLink,
          )}
          aria-label="Fantasy Bench home"
        >
          <LogoMark className={isLanding ? "size-9" : "size-7"} />
          <span
            className={cn(
              "display text-[13px] tracking-[0.12em]",
              inLeague && "hidden xl:inline",
              isLanding && styles.brandName,
            )}
          >
            Fantasy Bench
          </span>
        </Link>

        {inLeague && league ? (
          <>
            <span
              aria-hidden
              className="select-none text-lg font-light text-border"
            >
              /
            </span>
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
          <div
            className={cn(
              "hidden items-center gap-1 md:flex",
              isLanding && styles.navLinks,
            )}
          >
            {links.map((link) => {
              const active =
                pathname === link.href || pathname.startsWith(`${link.href}/`);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "rounded-md px-2.5 py-2 transition-colors hover:text-foreground",
                    isLanding ? "eyebrow-caps" : "eyebrow",
                    active && "text-foreground",
                  )}
                >
                  {link.label}
                </Link>
              );
            })}
          </div>
        )}

        <div
          className={cn(
            "ml-auto flex items-center gap-2",
            isLanding && styles.account,
          )}
        >
          {isLanding ? <GithubLink stars={githubStars} /> : null}
          {viewer === undefined ? (
            // First paint before the subscription resolves: reserve the space
            // rather than flashing "Log in" at someone who is signed in.
            <span className="h-8 w-20 sm:w-40" aria-hidden />
          ) : viewer ? (
            <>
              {inLeague ? null : (
                <Button
                  variant="brand"
                  size={isLanding ? "xl" : "lg"}
                  className={isLanding ? styles.primaryCta : undefined}
                  role="link"
                  render={<Link href={homeLeagueId ? `/leagues/${homeLeagueId}` : "/leagues?join=1"} />}
                >
                  {homeLeagueId ? "View league" : "Join a league"}
                  <ArrowUpRight data-icon="inline-end" />
                </Button>
              )}
              <UserMenu
                name={viewer.name ?? ""}
                email={viewer.email ?? ""}
                size={isLanding ? "xl" : "lg"}
              />
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "hidden hover:text-foreground sm:inline-flex",
                  isLanding ? "eyebrow-caps" : "eyebrow",
                )}
                role="link"
                render={<Link href="/login" />}
              >
                Log in
              </Button>
              <Button
                variant="brand"
                size={isLanding ? "xl" : "lg"}
                className={isLanding ? styles.primaryCta : undefined}
                role="link"
                render={<Link href="/signup" />}
              >
                Get started
                <ArrowUpRight data-icon="inline-end" />
              </Button>
            </>
          )}

          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={cn("md:hidden", isLanding && styles.menuTrigger)}
                  aria-label="Open menu"
                />
              }
            >
              <Menu />
            </SheetTrigger>
            <SheetContent side="right" className="w-72">
              <SheetHeader>
                <SheetTitle className="display text-sm tracking-[0.12em]">
                  Fantasy Bench
                </SheetTitle>
                <SheetDescription className="sr-only">
                  Site navigation
                </SheetDescription>
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
                <a
                  href={GITHUB_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setMenuOpen(false)}
                  className="eyebrow flex items-center justify-between rounded-md px-2 py-3 hover:bg-accent hover:text-foreground"
                >
                  GitHub
                  {githubStars === null ? null : (
                    <span className="font-mono text-xs text-muted-foreground">
                      ★ {formatStars(githubStars)}
                    </span>
                  )}
                </a>
                {viewer ? null : (
                  <Link
                    href="/login"
                    onClick={() => setMenuOpen(false)}
                    className="eyebrow rounded-md px-2 py-3 hover:bg-accent hover:text-foreground"
                  >
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
          <LeagueTabsRow
            entries={leagueEntries}
            className="mx-auto max-w-7xl px-4 sm:px-6"
          />
        </div>
      ) : null}
    </header>
  );
}

/**
 * Repository link with a live star count. The count is fetched server-side
 * and cached for an hour (see `lib/github.ts`); when GitHub is unreachable
 * the pill still links out, just without a number.
 */
function GithubLink({ stars }: { stars: number | null }) {
  return (
    <a
      href={GITHUB_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="hidden items-center gap-2 rounded-full bg-white/10 py-1.5 pr-4 pl-3 text-nowrap text-foreground transition-colors hover:bg-white/15 sm:flex"
    >
      <GithubIcon className="size-5 shrink-0" />
      <span className="flex flex-col">
        <span className="text-sm leading-none font-medium">GitHub</span>
        <span className="text-xs leading-tight text-foreground/60">
          {stars === null ? "Star us" : `${formatStars(stars)} stars`}
        </span>
      </span>
    </a>
  );
}

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 15 15"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M7.49933 0.25C3.49635 0.25 0.25 3.49593 0.25 7.50024C0.25 10.703 2.32715 13.4206 5.2081 14.3797C5.57084 14.446 5.70302 14.2222 5.70302 14.0299C5.70302 13.8576 5.69679 13.4019 5.69323 12.797C3.67661 13.235 3.25112 11.825 3.25112 11.825C2.92132 10.9874 2.44599 10.7644 2.44599 10.7644C1.78773 10.3149 2.49584 10.3238 2.49584 10.3238C3.22353 10.375 3.60629 11.0711 3.60629 11.0711C4.25298 12.1788 5.30335 11.8588 5.71638 11.6732C5.78225 11.205 5.96962 10.8854 6.17658 10.7043C4.56675 10.5209 2.87415 9.89918 2.87415 7.12104C2.87415 6.32925 3.15677 5.68257 3.62053 5.17563C3.54576 4.99226 3.29697 4.25521 3.69174 3.25691C3.69174 3.25691 4.30015 3.06196 5.68522 3.99973C6.26337 3.83906 6.8838 3.75895 7.50022 3.75583C8.1162 3.75895 8.73619 3.83906 9.31523 3.99973C10.6994 3.06196 11.3069 3.25691 11.3069 3.25691C11.7026 4.25521 11.4538 4.99226 11.3795 5.17563C11.8441 5.68257 12.1245 6.32925 12.1245 7.12104C12.1245 9.9063 10.4292 10.5192 8.81452 10.6985C9.07444 10.9224 9.30633 11.3648 9.30633 12.0413C9.30633 13.0102 9.29742 13.7922 9.29742 14.0299C9.29742 14.2239 9.42828 14.4496 9.79591 14.3788C12.6746 13.4179 14.75 10.7025 14.75 7.50024C14.75 3.49593 11.5036 0.25 7.49933 0.25Z"
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
      />
    </svg>
  );
}
