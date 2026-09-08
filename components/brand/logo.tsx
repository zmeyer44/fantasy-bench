import { cn } from "@/lib/utils";

/**
 * The FB monogram: a white F whose stem is cut on the diagonal, interlocked
 * with a lime B whose left stem carries football laces. Drawn with
 * `currentColor` for the F so it inherits the surrounding text colour.
 */
export function LogoMark({ className, title = "Fantasy Bench" }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 100 100"
      role="img"
      aria-label={title}
      className={cn("size-8 shrink-0", className)}
      fill="none"
    >
      {/* B (lime) */}
      <path
        fill="var(--brand)"
        fillRule="evenodd"
        d="M46 16h30c11 0 18 7.5 18 17 0 6-3 10.5-7.5 13C92 48.5 96 54 96 61.5 96 73 88 84 74 84H46Zm14 13v14h14c5 0 8-3 8-7s-3-7-8-7Zm0 27v15h15c5.5 0 9-3.2 9-7.5S80.5 56 75 56Z"
      />
      {/* laces cut into the B's stem */}
      <g stroke="var(--background)" strokeWidth="3" strokeLinecap="square">
        <path d="M53 30v42" />
        <path d="M47.5 37h11M47.5 46h11M47.5 55h11M47.5 64h11" />
      </g>
      {/* F (inherits colour) */}
      <path fill="currentColor" d="M8 16h44v13H24v11h22v12H24v18L8 84Z" />
    </svg>
  );
}

export function Wordmark({ className, stacked = false }: { className?: string; stacked?: boolean }) {
  return (
    <span
      className={cn(
        "display inline-flex leading-none",
        stacked ? "flex-col items-center gap-1" : "items-baseline gap-2",
        className,
      )}
    >
      <span className="text-foreground">Fantasy</span>
      <span className="text-brand">Bench</span>
    </span>
  );
}
