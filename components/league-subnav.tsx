"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/components/ui";

/**
 * Several of these routes are owned by other work packages and do not exist
 * yet — the links are intentionally live so the shell is complete as they land.
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
  { segment: "settings", label: "Settings" },
] as const;

export function LeagueSubnav({ leagueId }: { leagueId: string }) {
  const pathname = usePathname();
  const base = `/leagues/${leagueId}`;

  return (
    <nav className="-mb-px flex gap-1 overflow-x-auto border-b border-line">
      {SECTIONS.map((section) => {
        const href = section.segment ? `${base}/${section.segment}` : base;
        const active = section.segment
          ? pathname.startsWith(href)
          : pathname === base;
        return (
          <Link
            key={section.label}
            href={href}
            className={cn(
              "shrink-0 border-b-2 px-3 py-2.5 text-sm transition-colors",
              active
                ? "border-accent font-medium text-ink"
                : "border-transparent text-ink-muted hover:text-ink",
            )}
          >
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}
