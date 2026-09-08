import type { ComponentPropsWithoutRef } from "react";

import { cn } from "./utils";

export const FIELD_CLASS =
  "w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink " +
  "placeholder:text-ink-faint focus:border-accent focus:outline-none " +
  "disabled:cursor-not-allowed disabled:opacity-60";

export function Input({ className, ...props }: ComponentPropsWithoutRef<"input">) {
  return <input className={cn(FIELD_CLASS, "h-9 py-0", className)} {...props} />;
}

export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5" htmlFor={htmlFor}>
      <span className="eyebrow block">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-ink-faint">{hint}</span> : null}
    </label>
  );
}
