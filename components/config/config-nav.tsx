"use client";

import { ArrowLeft } from "lucide-react";
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
    <nav
      aria-label="Team configuration sections"
      className="-mb-px flex gap-1 overflow-x-auto border-b border-border"
    >
      <Link
        href={base}
        className="flex shrink-0 items-center gap-1.5 border-b-2 border-transparent px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Team
      </Link>
      {TABS.map((tab) => {
        const href = `${base}/${tab.segment}`;
        const active = tab.exact ? pathname === href : pathname.startsWith(href);
        return (
          <Link
            key={tab.segment}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "shrink-0 border-b-2 px-3 py-2.5 text-sm transition-colors",
              active
                ? "border-brand font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
