/** Public repository behind the product, linked from the landing page nav. */
export const GITHUB_REPO = "zmeyer44/fantasy-bench";
export const GITHUB_URL = `https://github.com/${GITHUB_REPO}`;

/**
 * Star count for the repository, or `null` when GitHub is unreachable or
 * rate-limits us. Cached by the Next.js data cache for an hour so the layout
 * never pays for the request on every render.
 */
export async function fetchGithubStars(): Promise<number | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}`, {
      headers: { Accept: "application/vnd.github+json" },
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    const stars =
      data && typeof data === "object" && "stargazers_count" in data
        ? (data as { stargazers_count?: unknown }).stargazers_count
        : undefined;
    return typeof stars === "number" ? stars : null;
  } catch {
    return null;
  }
}

/** `1234` → `1.2k`, `999` → `999`. */
export function formatStars(stars: number): string {
  if (stars < 1000) return String(stars);
  const k = stars / 1000;
  return `${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}k`;
}
