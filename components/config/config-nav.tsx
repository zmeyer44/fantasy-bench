"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/components/ui";

type Tab = { segment: string; label: string; exact?: boolean };

const TABS: Tab[] = [
  { segment: "config", label: "Editor", exact: true },
  { segment: "config/versions", label: "Versions" },
  { segment: "film-room", label: "Film room" },
];

/** Sub-navigation for a team's owner-console pages. */
export function ConfigNav({ leagueId, teamId }: { leagueId: string; teamId: string }) {
  const pathname = usePathname();
  const base = `/leagues/${leagueId}/teams/${teamId}`;

  return (
    <nav className="-mb-px flex gap-1 border-b border-line">
      <Link
        href={base}
        className="shrink-0 border-b-2 border-transparent px-3 py-2 text-sm text-ink-muted transition-colors hover:text-ink"
      >
        ← Team
      </Link>
      {TABS.map((tab) => {
        const href = `${base}/${tab.segment}`;
        const active = tab.exact ? pathname === href : pathname.startsWith(href);
        return (
          <Link
            key={tab.segment}
            href={href}
            className={cn(
              "shrink-0 border-b-2 px-3 py-2 text-sm transition-colors",
              active
                ? "border-accent font-medium text-ink"
                : "border-transparent text-ink-muted hover:text-ink",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
