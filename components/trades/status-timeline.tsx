import { cn } from "@/components/ui";

/**
 * The proposal lifecycle rendered as a rail. The terminal step is whichever
 * branch this trade actually took, so a rejected trade shows `rejected` rather
 * than a greyed-out `completed`.
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

export function StatusTimeline({ status }: { status: string }) {
  const steps = TERMINAL[status] ?? [...HAPPY_PATH];
  const reachedIndex = steps.indexOf(status === "accepted" ? "accepted" : status);
  const current = reachedIndex === -1 ? steps.length - 1 : reachedIndex;

  return (
    <ol className="flex flex-wrap items-center gap-1.5">
      {steps.map((step, index) => {
        const done = index <= current;
        const isTerminalBad = done && index === current && BAD.has(step);
        return (
          <li key={step} className="flex items-center gap-1.5">
            {index > 0 ? (
              <span aria-hidden className="text-ink-faint">
                →
              </span>
            ) : null}
            <span
              className={cn(
                "rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider",
                isTerminalBad
                  ? "border-danger/40 bg-danger/15 text-danger"
                  : done
                    ? "border-accent/40 bg-accent-soft text-accent-strong"
                    : "border-line bg-surface-muted text-ink-faint",
              )}
            >
              {step.replace("_", " ")}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
