const FALLBACK_RETURN_PATH = "/leagues";
const RETURN_BASE = "https://fantasy-bench.invalid";

/** Accept only canonical same-origin application paths for post-auth navigation. */
export function normalizeReturnPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return FALLBACK_RETURN_PATH;
  }
  try {
    const parsed = new URL(value, RETURN_BASE);
    if (parsed.origin !== RETURN_BASE) return FALLBACK_RETURN_PATH;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return FALLBACK_RETURN_PATH;
  }
}

export function authHref(path: "/login" | "/signup" | "/forgot-password", next: string): string {
  return `${path}?next=${encodeURIComponent(normalizeReturnPath(next))}`;
}
