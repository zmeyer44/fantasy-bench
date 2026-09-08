"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

import { Button, Input, NativeSelect, NativeSelectOption } from "@/components/ui";

const WINDOW_TYPES = ["draft", "waiver", "trade", "lineup", "forum", "commissioner"] as const;
const STATUSES = [
  "succeeded",
  "partial",
  "failed",
  "timed_out",
  "fallback",
  "running",
  "pending",
  "skipped",
] as const;

/**
 * Filters + search for `/traces`. State lives in the URL so a filtered view is
 * shareable and the list itself stays a Server Component.
 */
export function TraceFilters({
  basePath,
  teams,
  models,
  weeks,
}: {
  basePath: string;
  teams: Array<{ id: string; name: string }>;
  models: Array<{ modelId: string; label: string; runCount: number }>;
  weeks: number[];
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const activeQuery = params.get("q") ?? "";

  const apply = (next: Record<string, string>) => {
    const search = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value) search.set(key, value);
      else search.delete(key);
    }
    search.delete("page");
    startTransition(() => router.push(`${basePath}?${search.toString()}`));
  };

  const value = (key: string) => params.get(key) ?? "";
  const hasFilters = ["team", "window", "week", "status", "model", "q"].some((key) =>
    params.get(key),
  );

  return (
    <div className="space-y-2.5">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const value = new FormData(event.currentTarget).get("q");
          apply({ q: typeof value === "string" ? value.trim() : "" });
        }}
        className="flex flex-wrap gap-2"
      >
        {/* Uncontrolled, keyed by the URL: a back/forward navigation remounts it
            with the right value without an effect syncing state. */}
        <Input
          key={activeQuery}
          name="q"
          defaultValue={activeQuery}
          placeholder="Search traces — player name, tool name, or any text"
          className="min-w-64 flex-1"
          aria-label="Search traces"
        />
        <Button type="submit" variant="outline" disabled={pending}>
          Search
        </Button>
        {hasFilters ? (
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => startTransition(() => router.push(basePath))}
          >
            Clear
          </Button>
        ) : null}
      </form>

      <div className="flex flex-wrap gap-2">
        <NativeSelect
          size="sm"
          aria-label="Team"
          value={value("team")}
          onChange={(event) => apply({ team: event.target.value })}
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
          aria-label="Window type"
          value={value("window")}
          onChange={(event) => apply({ window: event.target.value })}
        >
          <NativeSelectOption value="">All windows</NativeSelectOption>
          {WINDOW_TYPES.map((type) => (
            <NativeSelectOption key={type} value={type}>
              {type}
            </NativeSelectOption>
          ))}
        </NativeSelect>

        <NativeSelect
          size="sm"
          aria-label="Week"
          value={value("week")}
          onChange={(event) => apply({ week: event.target.value })}
        >
          <NativeSelectOption value="">All weeks</NativeSelectOption>
          {weeks.map((week) => (
            <NativeSelectOption key={week} value={String(week)}>
              Week {week}
            </NativeSelectOption>
          ))}
        </NativeSelect>

        <NativeSelect
          size="sm"
          aria-label="Status"
          value={value("status")}
          onChange={(event) => apply({ status: event.target.value })}
        >
          <NativeSelectOption value="">Any status</NativeSelectOption>
          {STATUSES.map((status) => (
            <NativeSelectOption key={status} value={status}>
              {status.replace("_", " ")}
            </NativeSelectOption>
          ))}
        </NativeSelect>

        <NativeSelect
          size="sm"
          aria-label="Model"
          value={value("model")}
          onChange={(event) => apply({ model: event.target.value })}
        >
          <NativeSelectOption value="">Any model</NativeSelectOption>
          {models.map((model) => (
            <NativeSelectOption key={model.modelId} value={model.modelId}>
              {model.label} ({model.runCount})
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
    </div>
  );
}
