"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

import { NativeSelect, NativeSelectOption } from "@/components/ui";

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
      <NativeSelect
        size="sm"
        className="w-44"
        aria-label="Filter by team"
        value={params.get("team") ?? ""}
        onChange={(event) => update("team", event.target.value)}
      >
        <NativeSelectOption value="">All teams</NativeSelectOption>
        {teams.map((team) => (
          <NativeSelectOption key={team.id} value={team.id}>
            {team.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>

      <NativeSelect
        size="sm"
        className="w-32"
        aria-label="Filter by week"
        value={params.get("week") ?? ""}
        onChange={(event) => update("week", event.target.value)}
      >
        <NativeSelectOption value="">All weeks</NativeSelectOption>
        {weeks.map((week) => (
          <NativeSelectOption key={week} value={String(week)}>
            Week {week}
          </NativeSelectOption>
        ))}
      </NativeSelect>

      {showStatus ? (
        <NativeSelect
          size="sm"
          className="w-40"
          aria-label="Filter by status"
          value={params.get("status") ?? ""}
          onChange={(event) => update("status", event.target.value)}
        >
          <NativeSelectOption value="">Any status</NativeSelectOption>
          {STATUSES.map((status) => (
            <NativeSelectOption key={status} value={status}>
              {status.replace("_", " ")}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      ) : null}
    </div>
  );
}
