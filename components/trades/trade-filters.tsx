"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

import { Select } from "@/components/ui";

const STATUSES = [
  "proposed",
  "countered",
  "in_review",
  "completed",
  "rejected",
  "expired",
  "vetoed",
  "cancelled",
] as const;

/**
 * Filters live in the URL so a filtered feed is shareable and the page stays a
 * Server Component — changing a select just rewrites the query string.
 */
export function TradeFilters({
  teams,
  weeks,
  showStatus = true,
}: {
  teams: Array<{ id: string; name: string }>;
  weeks: number[];
  showStatus?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    startTransition(() => {
      router.replace(next.size ? `${pathname}?${next}` : pathname, { scroll: false });
    });
  };

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-pending={pending ? "" : undefined}
    >
      <Select
        aria-label="Filter by team"
        value={params.get("team") ?? ""}
        onChange={(event) => update("team", event.target.value)}
        className="w-44"
      >
        <option value="">All teams</option>
        {teams.map((team) => (
          <option key={team.id} value={team.id}>
            {team.name}
          </option>
        ))}
      </Select>

      <Select
        aria-label="Filter by week"
        value={params.get("week") ?? ""}
        onChange={(event) => update("week", event.target.value)}
        className="w-32"
      >
        <option value="">All weeks</option>
        {weeks.map((week) => (
          <option key={week} value={String(week)}>
            Week {week}
          </option>
        ))}
      </Select>

      {showStatus ? (
        <Select
          aria-label="Filter by status"
          value={params.get("status") ?? ""}
          onChange={(event) => update("status", event.target.value)}
          className="w-40"
        >
          <option value="">Any status</option>
          {STATUSES.map((status) => (
            <option key={status} value={status}>
              {status.replace("_", " ")}
            </option>
          ))}
        </Select>
      ) : null}
    </div>
  );
}
