"use client";

import { Lock } from "lucide-react";

import { Badge, Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * Marks a model that only runs on a team's own gateway key. The badge is a
 * real button so keyboard users reach the explanation.
 */
export function OwnKeyBadge({
  hasKey,
  compact = false,
  className,
}: {
  /** Whether the viewer's team has a key on file; changes the copy, not the badge. */
  hasKey?: boolean;
  /** Icon only, for dense table rows. */
  compact?: boolean;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            variant="warning"
            render={<button type="button" aria-label="Requires your own gateway key" />}
            className={cn("cursor-help", compact && "px-1", className)}
          />
        }
      >
        <Lock aria-hidden />
        {compact ? null : "Own key"}
      </TooltipTrigger>
      <TooltipContent className="block max-w-64 text-left leading-relaxed normal-case tracking-normal">
        <span className="block font-medium">Requires your own gateway key</span>
        <span className="mt-1 block opacity-90">
          One of the most expensive models in the catalog, so it never bills to the league&apos;s
          shared key.{" "}
          {hasKey
            ? "Your team has a key on file, so it runs on yours."
            : "Add a Vercel AI Gateway key under Spend to unlock it."}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
