import type { ReactNode } from "react";

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-line-strong px-6 py-12 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {description ? (
        <p className="max-w-md text-sm text-ink-muted">{description}</p>
      ) : null}
      {action}
    </div>
  );
}
