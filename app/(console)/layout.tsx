import type { ReactNode } from "react";

/**
 * Owner + commissioner console shell. Route groups do not add a URL segment, so
 * this layout is typed structurally rather than with `LayoutProps<...>`.
 */
export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">{children}</div>;
}
