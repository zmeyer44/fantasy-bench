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
  { segment: "my-team", label: "My Team" },
  { segment: "matchups", label: "Matchups" },
  { segment: "standings", label: "Standings" },
  { segment: "teams", label: "Teams" },
  { segment: "waivers", label: "Players & waivers" },
  { segment: "draft", label: "Draft" },
  { segment: "trades", label: "Trades" },
  { segment: "commons", label: "Commons" },
  { segment: "traces", label: "Traces" },
  { segment: "cost", label: "Cost" },
  { segment: "settings", label: "Settings", commissionerOnly: true },
] as const;

export function LeagueSubnav({
  leagueId,
  isCommissioner = false,
  myTeamId = null,
}: {
  leagueId: string;
  isCommissioner?: boolean;
  myTeamId?: string | null;
}) {
  const pathname = usePathname();
  const base = `/leagues/${leagueId}`;
  const myTeamHref = myTeamId ? `${base}/teams/${myTeamId}` : null;
  const onMyTeam = Boolean(
    myTeamHref && (pathname === myTeamHref || pathname.startsWith(`${myTeamHref}/`)),
  );

  return (
    <nav aria-label="League sections" className="-mb-px flex gap-1 overflow-x-auto">
      {SECTIONS.filter(
        (section) =>
          (section.segment !== "my-team" || myTeamHref !== null) &&
          (!("commissionerOnly" in section && section.commissionerOnly) || isCommissioner),
      ).map((section) => {
        const href = section.segment === "my-team"
          ? myTeamHref!
          : section.segment ? `${base}/${section.segment}` : base;
        const active = section.segment === "my-team"
          ? onMyTeam
          : section.segment === "teams" && onMyTeam
            ? false
            : pathname === href || (section.segment !== "" && pathname.startsWith(`${href}/`));
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
