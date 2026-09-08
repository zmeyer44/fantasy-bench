import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "./empty";

/** Product-level empty state built on the shadcn `Empty` primitive. */
export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <Empty className={cn("border border-dashed border-line-strong py-12", className)}>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}
