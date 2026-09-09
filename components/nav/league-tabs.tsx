"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
  cn,
} from "@/components/ui";

import type { LeagueNavEntry, LeagueNavLink } from "./league-sections";
import { flattenLeagueNav } from "./league-sections";

const TAB =
  "eyebrow relative flex h-14 shrink-0 items-center gap-1 px-2.5 transition-colors hover:text-foreground outline-none focus-visible:text-foreground";
const TAB_ACTIVE =
  "text-foreground after:absolute after:inset-x-2.5 after:-bottom-px after:h-0.5 after:bg-brand";

/** Desktop: the league sections as tabs in the site nav bar, groups as menus. */
export function LeagueTabs({ entries, className }: { entries: LeagueNavEntry[]; className?: string }) {
  return (
    <nav aria-label="League sections" className={cn("flex items-center", className)}>
      {entries.map((entry) =>
        entry.kind === "link" ? (
          <Link
            key={entry.href}
            href={entry.href}
            aria-current={entry.active ? "page" : undefined}
            className={cn(TAB, entry.active && TAB_ACTIVE)}
          >
            {entry.label}
          </Link>
        ) : (
          <DropdownMenu key={entry.label}>
            <DropdownMenuTrigger
              className={cn(TAB, entry.active && TAB_ACTIVE, "data-popup-open:text-foreground")}
            >
              {entry.label}
              <ChevronDown className="size-3 opacity-70" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-44">
              <DropdownMenuGroup>
                {entry.items.map((item) => (
                  <DropdownMenuItem
                    key={item.href}
                    render={<Link href={item.href} aria-current={item.active ? "page" : undefined} />}
                    className={cn(item.active && "font-medium text-foreground")}
                  >
                    {item.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      )}
    </nav>
  );
}

/** Below `lg`: every section in one scrolling row under the main bar. */
export function LeagueTabsRow({ entries, className }: { entries: LeagueNavEntry[]; className?: string }) {
  const links: LeagueNavLink[] = flattenLeagueNav(entries);
  const row = useRef<HTMLElement>(null);
  const activeHref = links.find((link) => link.active)?.href;
  useEffect(() => {
    const nav = row.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active) return;
    const reveal = () => {
      const tab = active.getBoundingClientRect();
      const viewport = nav.getBoundingClientRect();
      // Move only the strip: scrollIntoView can also jump the page vertically.
      if (tab.left < viewport.left || tab.right > viewport.right) {
        nav.scrollLeft += tab.left - viewport.left - (viewport.width - tab.width) / 2;
      }
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [activeHref]);
  return (
    <nav
      ref={row}
      aria-label="League sections"
      className={cn("flex overflow-x-auto [scrollbar-width:thin] [scrollbar-color:var(--color-border)_transparent]", className)}
    >
      {links.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          aria-current={link.active ? "page" : undefined}
          className={cn(
            "shrink-0 border-b-2 px-3 py-2.5 text-sm transition-colors",
            link.active
              ? "border-brand font-medium text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
