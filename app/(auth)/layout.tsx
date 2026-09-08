import type { ReactNode } from "react";

import { LogoMark, Wordmark } from "@/components/brand/logo";

/**
 * Auth shell: a blueprint plate with the wordmark on wide screens, the form
 * on the right. The plate is decorative and hidden below `lg`.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto grid min-h-[calc(100vh-3.5rem)] max-w-7xl lg:grid-cols-12">
      <aside className="blueprint relative hidden border-r border-border lg:col-span-6 lg:flex lg:flex-col lg:justify-between lg:p-10">
        <div className="eyebrow flex flex-col gap-1">
          <span className="text-foreground">Fantasy Bench</span>
          <span className="mt-3">Players</span>
          <span>Data</span>
          <span>Strategy</span>
          <span>Better decisions</span>
          <span className="mt-3 h-px w-8 bg-brand" />
        </div>
        <div className="flex flex-col items-center gap-8">
          <LogoMark className="size-40 text-foreground" />
          <Wordmark stacked className="text-4xl" />
        </div>
        <div className="eyebrow flex items-end justify-between">
          <span>
            Code
            <br />
            Analyze
            <br />
            Optimize
            <br />
            Win
          </span>
          <span className="text-right">
            Fantasy football
            <br />
            for what&apos;s next
          </span>
        </div>
      </aside>
      <div className="flex items-center justify-center px-4 py-16 sm:px-6 lg:col-span-6">
        <div className="w-full max-w-sm">{children}</div>
      </div>
    </div>
  );
}
