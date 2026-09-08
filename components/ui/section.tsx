import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * A ruled section: tracked label, optional title, optional right-aligned
 * meta or action, and a hairline underneath. This is the grouping device of
 * the console; it replaces card-in-card nesting. For a table body, pass
 * `className="mb-0"` on the header so the table sits against the rule.
 */
export function Section({
  className,
  children,
  ...props
}: React.ComponentProps<"section">) {
  return (
    <section data-slot="section" className={cn("min-w-0", className)} {...props}>
      {children}
    </section>
  );
}

export function SectionHeader({
  eyebrow,
  title,
  description,
  action,
  className,
}: {
  eyebrow?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="section-header"
      className={cn(
        "mb-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-2 border-b border-border pb-3",
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
        {title ? (
          <h2 className={cn("text-base font-semibold text-foreground", eyebrow && "mt-1.5")}>
            {title}
          </h2>
        ) : null}
        {description ? (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action ? (
        <div className="flex shrink-0 items-center gap-2 font-mono text-xs text-muted-foreground">
          {action}
        </div>
      ) : null}
    </div>
  );
}
