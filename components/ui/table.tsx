import type { ComponentPropsWithoutRef } from "react";

import { cn } from "./utils";

/** Wraps the table so wide content scrolls inside the card, never the page. */
export function Table({ className, ...props }: ComponentPropsWithoutRef<"table">) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn("w-full border-collapse text-sm", className)} {...props} />
    </div>
  );
}

export function THead({ className, ...props }: ComponentPropsWithoutRef<"thead">) {
  return <thead className={cn("border-b border-line", className)} {...props} />;
}

export function TBody({ className, ...props }: ComponentPropsWithoutRef<"tbody">) {
  return <tbody className={cn("divide-y divide-line", className)} {...props} />;
}

export function TR({ className, ...props }: ComponentPropsWithoutRef<"tr">) {
  return <tr className={cn("hover:bg-surface-muted/60", className)} {...props} />;
}

export function TH({
  className,
  numeric,
  ...props
}: ComponentPropsWithoutRef<"th"> & { numeric?: boolean }) {
  return (
    <th
      className={cn(
        "px-3 py-2 font-mono text-[10px] font-medium uppercase tracking-wider text-ink-faint",
        numeric ? "text-right" : "text-left",
        className,
      )}
      {...props}
    />
  );
}

export function TD({
  className,
  numeric,
  ...props
}: ComponentPropsWithoutRef<"td"> & { numeric?: boolean }) {
  return (
    <td
      className={cn("px-3 py-2 text-ink", numeric && "text-right tabular-nums", className)}
      {...props}
    />
  );
}
