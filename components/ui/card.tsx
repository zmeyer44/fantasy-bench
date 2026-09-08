import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { cn } from "./utils";

export function Card({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn("rounded-lg border border-line bg-surface shadow-xs", className)}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  action,
  description,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 border-b border-line px-4 py-3",
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold text-ink">{title}</h2>
        {description ? (
          <p className="mt-0.5 text-xs text-ink-muted">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function CardBody({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return <div className={cn("px-4 py-3", className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn("border-t border-line px-4 py-3 text-xs text-ink-muted", className)}
      {...props}
    />
  );
}
