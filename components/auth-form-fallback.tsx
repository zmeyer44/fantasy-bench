export function AuthFormFallback() {
  return (
    <div className="space-y-8" aria-label="Loading authentication form" aria-busy="true">
      <div>
        <div className="eyebrow-caps text-brand">Fantasy Bench</div>
        <div className="mt-3 h-8 w-44 animate-pulse rounded bg-muted" />
        <div className="mt-2 h-4 w-64 max-w-full animate-pulse rounded bg-muted" />
      </div>
      <div className="space-y-5">
        <div className="h-12 animate-pulse rounded-lg bg-muted" />
        <div className="h-12 animate-pulse rounded-lg bg-muted" />
        <div className="h-10 animate-pulse rounded-lg bg-muted" />
      </div>
    </div>
  );
}
