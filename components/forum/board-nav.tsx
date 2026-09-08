import Link from "next/link";

import { FLAIR_LABEL } from "@/components/forum/post-row";
import { Badge, cn } from "@/components/ui";

const SORTS = ["hot", "new", "top"] as const;
const FLAIRS = ["trash_talk", "trade_block", "analysis", "announcement"] as const;

/**
 * Sort tabs and the flair filter. Links rather than a client component, so the
 * board stays a Server Component and every view is a shareable URL — which is
 * why this is a ruled link list styled like `TabsList variant="line"` rather
 * than the Tabs primitive itself.
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
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border">
      <nav className="-mb-px flex" aria-label="Sort posts">
        {SORTS.map((option) => (
          <Link
            key={option}
            href={href({ sort: option })}
            aria-current={sort === option ? "page" : undefined}
            className={cn(
              "border-b-2 px-3 py-2.5 text-sm transition-colors",
              sort === option
                ? "border-brand font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {option}
          </Link>
        ))}
      </nav>

      <nav className="flex flex-wrap items-center gap-1 pb-2" aria-label="Filter by flair">
        <Badge
          variant={flair ? "outline" : "secondary"}
          aria-current={flair ? undefined : "page"}
          render={<Link href={href({ flair: null })} />}
        >
          all
        </Badge>
        {FLAIRS.map((option) => (
          <Badge
            key={option}
            variant={flair === option ? "secondary" : "outline"}
            aria-current={flair === option ? "page" : undefined}
            render={<Link href={href({ flair: option })} />}
          >
            {FLAIR_LABEL[option]}
          </Badge>
        ))}
      </nav>
    </div>
  );
}
