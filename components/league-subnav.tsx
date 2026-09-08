"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

/**
 * League section navigation. `Settings` is the commissioner console and is
 * only shown to commissioners; the route itself renders a 403 for everyone
 * else regardless.
 */
const SECTIONS = [
  { segment: "", label: "Home" },
  { segment: "standings", label: "Standings" },
  { segment: "teams", label: "Teams" },
  { segment: "draft", label: "Draft" },
  { segment: "waivers", label: "Waivers" },
  { segment: "trades", label: "Trades" },
  { segment: "commons", label: "Commons" },
  { segment: "traces", label: "Traces" },
  { segment: "cost", label: "Cost" },
  { segment: "settings", label: "Settings", commissionerOnly: true },
] as const;

export function LeagueSubnav({
  leagueId,
  isCommissioner = false,
}: {
  leagueId: string;
  isCommissioner?: boolean;
}) {
  const pathname = usePathname();
  const base = `/leagues/${leagueId}`;

  return (
    <nav aria-label="League sections" className="-mb-px flex gap-1 overflow-x-auto">
      {SECTIONS.filter(
        (section) => !("commissionerOnly" in section && section.commissionerOnly) || isCommissioner,
      ).map((section) => {
        const href = section.segment ? `${base}/${section.segment}` : base;
        const active = section.segment ? pathname.startsWith(href) : pathname === base;
        return (
          <Link
            key={section.label}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "shrink-0 border-b-2 px-3 py-2.5 text-sm transition-colors",
              active
                ? "border-brand font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}
