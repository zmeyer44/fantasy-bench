import type { ComponentPropsWithoutRef } from "react";

import { cn } from "./utils";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-md border font-medium " +
  "transition-colors disabled:cursor-not-allowed disabled:opacity-50";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "border-accent-strong bg-accent text-white hover:bg-accent-strong dark:text-canvas",
  secondary:
    "border-line-strong bg-surface text-ink hover:bg-surface-muted",
  ghost: "border-transparent bg-transparent text-ink-muted hover:bg-surface-muted hover:text-ink",
  danger: "border-danger bg-danger text-white hover:opacity-90",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-9 px-4 text-sm",
};

export type ButtonProps = ComponentPropsWithoutRef<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export function Button({
  variant = "primary",
  size = "md",
  className,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(BASE, VARIANTS[variant], SIZES[size], className)}
      {...props}
    />
  );
}
