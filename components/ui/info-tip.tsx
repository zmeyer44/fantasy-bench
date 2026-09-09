"use client";

import { Info } from "lucide-react";
import type { ReactNode } from "react";

import { GLOSSARY, type GlossaryTerm } from "@/lib/glossary";
import { cn } from "@/lib/utils";

import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

/**
 * A small info icon that explains a label on hover or focus. Pass a glossary
 * `term` for the shared definitions, or `children` for one-off copy. The icon
 * is a real button so keyboard users reach it and screen readers get the label.
 */
export function InfoTip({
  term,
  label,
  children,
  side = "top",
  className,
}: {
  term?: GlossaryTerm;
  /** Accessible name; defaults to "About <term>". */
  label?: string;
  children?: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
}) {
  const entry = term ? GLOSSARY[term] : null;
  const name = label ?? (entry ? `About ${entry.term}` : "More information");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={name}
            className={cn(
              "inline-flex size-4 shrink-0 items-center justify-center rounded-full align-middle text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              className,
            )}
          />
        }
      >
        <Info className="size-3.5" aria-hidden />
      </TooltipTrigger>
      <TooltipContent side={side} className="block max-w-64 text-left leading-relaxed normal-case tracking-normal">
        {entry ? (
          <>
            <span className="block font-medium">
              {entry.term}
              <span className="font-normal opacity-70"> · {entry.expansion}</span>
            </span>
            <span className="mt-1 block opacity-90">{entry.text}</span>
          </>
        ) : null}
        {children}
      </TooltipContent>
    </Tooltip>
  );
}
