import { cn } from "@/components/ui";

/**
 * The proposal lifecycle rendered as a rail. The terminal step is whichever
 * branch this trade actually took, so a rejected trade shows `rejected` rather
 * than a greyed-out `completed`.
 *
 * Vertically it is a ruled list — one hairline per transition, the step the
 * trade is actually on marked in lime (red when the branch is a bad one) and
 * everything ahead of it faint. The horizontal form is for the feed card, where
 * the timeline is a single footer line.
 */
const HAPPY_PATH = ["proposed", "accepted", "in_review", "completed"] as const;

const TERMINAL: Record<string, string[]> = {
  countered: ["proposed", "countered"],
  rejected: ["proposed", "rejected"],
  expired: ["proposed", "expired"],
  cancelled: ["proposed", "accepted", "in_review", "cancelled"],
  vetoed: ["proposed", "accepted", "in_review", "vetoed"],
};

const BAD = new Set(["rejected", "expired", "vetoed", "cancelled"]);

export function StatusTimeline({
  status,
  orientation = "vertical",
}: {
  status: string;
  orientation?: "vertical" | "horizontal";
}) {
  const steps = TERMINAL[status] ?? [...HAPPY_PATH];
  const reachedIndex = steps.indexOf(
    status === "accepted" ? "accepted" : status,
  );
  const current = reachedIndex === -1 ? steps.length - 1 : reachedIndex;
  const currentIsBad = BAD.has(steps[current] ?? "");

  if (orientation === "horizontal") {
    return (
      <ol className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
        {steps.map((step, index) => {
          const done = index <= current;
          const isCurrent = index === current;
          return (
            <li key={step} className="flex items-center gap-1.5">
              {index > 0 ? (
                <span aria-hidden className="text-ink-faint">
                  ·
                </span>
              ) : null}
              <span
                className={cn(
                  isCurrent && currentIsBad
                    ? "text-destructive"
                    : isCurrent
                      ? "text-brand"
                      : done
                        ? "text-muted-foreground"
                        : "text-ink-faint",
                )}
                aria-current={isCurrent ? "step" : undefined}
              >
                {step.replace("_", " ")}
              </span>
            </li>
          );
        })}
      </ol>
    );
  }

  return (
    <ol className="border-y border-border">
      {steps.map((step, index) => {
        const done = index <= current;
        const isCurrent = index === current;
        return (
          <li
            key={step}
            aria-current={isCurrent ? "step" : undefined}
            className="flex items-center gap-2.5 border-b border-border py-2 last:border-b-0"
          >
            <span
              aria-hidden
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                isCurrent && currentIsBad
                  ? "bg-destructive"
                  : isCurrent
                    ? "bg-brand"
                    : done
                      ? "bg-muted-foreground"
                      : "bg-border",
              )}
            />
            <span
              className={cn(
                "font-mono text-[11px]",
                isCurrent && currentIsBad
                  ? "text-destructive"
                  : isCurrent
                    ? "text-brand"
                    : done
                      ? "text-muted-foreground"
                      : "text-ink-faint",
              )}
            >
              {step.replace("_", " ")}
            </span>
            {isCurrent ? (
              <span className="eyebrow ml-auto text-ink-faint">now</span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
