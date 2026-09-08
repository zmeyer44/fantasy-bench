"use client";

import { useRouter } from "next/navigation";
import { useId } from "react";

import { NativeSelect, NativeSelectOption } from "@/components/ui";

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
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="eyebrow">
        {label}
      </label>
      <NativeSelect
        id={id}
        size="sm"
        value={weekNo}
        onChange={(event) => router.push(`${basePath}/${event.target.value}`)}
      >
        {weeks.map((week) => (
          <NativeSelectOption key={week} value={week}>
            {week}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  );
}
