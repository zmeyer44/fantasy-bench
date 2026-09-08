import Link from "next/link";

import { FLAIR_LABEL } from "@/components/forum/post-row";
import { cn } from "@/components/ui";

const SORTS = ["hot", "new", "top"] as const;
const FLAIRS = ["trash_talk", "trade_block", "analysis", "announcement"] as const;

/**
 * Sort tabs and the flair filter. Links rather than a client component, so the
 * board stays a Server Component and every view is a shareable URL.
 */
export function BoardNav({
  basePath,
  sort,
  flair,
}: {
  basePath: string;
  sort: string;
  flair?: string;
}) {
  const href = (next: { sort?: string; flair?: string | null }) => {
    const params = new URLSearchParams();
    const nextSort = next.sort ?? sort;
    if (nextSort && nextSort !== "hot") params.set("sort", nextSort);
    const nextFlair = next.flair === null ? undefined : (next.flair ?? flair);
    if (nextFlair) params.set("flair", nextFlair);
    const query = params.toString();
    return query ? `${basePath}?${query}` : basePath;
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line">
      <nav className="-mb-px flex gap-1" aria-label="Sort posts">
        {SORTS.map((option) => (
          <Link
            key={option}
            href={href({ sort: option })}
            aria-current={sort === option ? "page" : undefined}
            className={cn(
              "border-b-2 px-3 py-2 text-sm transition-colors",
              sort === option
                ? "border-accent font-medium text-ink"
                : "border-transparent text-ink-muted hover:text-ink",
            )}
          >
            {option}
          </Link>
        ))}
      </nav>

      <nav className="flex flex-wrap items-center gap-1 pb-2" aria-label="Filter by flair">
        <Link
          href={href({ flair: null })}
          className={cn(
            "rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors",
            flair
              ? "border-line bg-surface-muted text-ink-muted hover:text-ink"
              : "border-accent/40 bg-accent-soft text-accent-strong",
          )}
        >
          all
        </Link>
        {FLAIRS.map((option) => (
          <Link
            key={option}
            href={href({ flair: option })}
            className={cn(
              "rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors",
              flair === option
                ? "border-accent/40 bg-accent-soft text-accent-strong"
                : "border-line bg-surface-muted text-ink-muted hover:text-ink",
            )}
          >
            {FLAIR_LABEL[option]}
          </Link>
        ))}
      </nav>
    </div>
  );
}
