"use client";

import { useRouter } from "next/navigation";

/** Week selector that navigates to `${basePath}/${week}`. */
export function WeekPicker({
  basePath,
  weekNo,
  weeks,
  label = "Week",
}: {
  basePath: string;
  weekNo: number;
  weeks: number[];
  label?: string;
}) {
  const router = useRouter();
  return (
    <label className="flex items-center gap-2 text-xs text-ink-muted">
      <span className="eyebrow">{label}</span>
      <select
        value={weekNo}
        onChange={(event) => router.push(`${basePath}/${event.target.value}`)}
        className="h-8 rounded-md border border-line-strong bg-surface px-2 text-sm text-ink focus:border-accent focus:outline-none"
      >
        {weeks.map((week) => (
          <option key={week} value={week}>
            {week}
          </option>
        ))}
      </select>
    </label>
  );
}
