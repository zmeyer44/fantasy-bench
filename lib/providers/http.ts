/**
 * The one place providers are allowed to touch the network.
 *
 * Every call gets a 15s timeout and two retries, and *never throws* on a
 * partial or failed response — callers get `null` and log-and-skip, because a
 * provider outage at 12:58 PM on a Sunday must not blank a lineup (PRD §12).
 * `fetchImpl` is injectable so tests run against fixtures with no network.
 */

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type HttpOptions = {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  /** Prefixed to every log line so a failure names its provider. */
  label?: string;
};

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_RETRIES = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function providerLog(label: string, message: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message : err ? String(err) : "";
  console.warn(`[providers/${label}] ${message}${detail ? `: ${detail}` : ""}`);
}

/**
 * GET `url` and return the parsed body, or `null` when every attempt failed.
 * Retries are linear (400ms, 800ms) — providers here are CDN-cached, so a
 * longer backoff would just push us past the tick budget.
 */
export async function fetchWithRetry(
  url: string,
  opts: HttpOptions = {},
): Promise<Response | null> {
  const {
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    headers,
    label = "http",
  } = opts;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, {
        headers: { accept: "application/json", ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return res;
      // 4xx other than 429 will not fix itself; stop early.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        providerLog(label, `GET ${url} -> ${res.status} (not retrying)`);
        return null;
      }
      providerLog(label, `GET ${url} -> ${res.status} (attempt ${attempt + 1})`);
    } catch (err) {
      providerLog(label, `GET ${url} failed (attempt ${attempt + 1})`, err);
    }
    if (attempt < retries) await sleep(400 * (attempt + 1));
  }
  return null;
}

export async function fetchJson<T>(url: string, opts: HttpOptions = {}): Promise<T | null> {
  const res = await fetchWithRetry(url, opts);
  if (!res) return null;
  try {
    return (await res.json()) as T;
  } catch (err) {
    providerLog(opts.label ?? "http", `GET ${url} returned unparseable JSON`, err);
    return null;
  }
}

export async function fetchText(url: string, opts: HttpOptions = {}): Promise<string | null> {
  const res = await fetchWithRetry(url, { ...opts, headers: { accept: "text/plain", ...opts.headers } });
  if (!res) return null;
  try {
    return await res.text();
  } catch (err) {
    providerLog(opts.label ?? "http", `GET ${url} returned unreadable body`, err);
    return null;
  }
}

// ------------------------------------------------------------ tiny coercions

export function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function str(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number") return String(value);
  return null;
}

/** Keep only finite numeric entries — provider stat bags are full of nulls. */
export function numericStats(input: unknown): Record<string, number> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const parsed = num(value);
    if (parsed !== null) out[key] = parsed;
  }
  return out;
}
