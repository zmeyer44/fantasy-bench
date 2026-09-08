/**
 * Data providers (PRD §6.5). The barrel keeps the provider layer swappable:
 * callers depend on the normalized shapes in `./types`, never on a vendor.
 */
export * from "./types";
export * from "./teams";
export {
  fetchJson,
  fetchText,
  fetchWithRetry,
  providerLog,
  DEFAULT_RETRIES,
  DEFAULT_TIMEOUT_MS,
  type FetchLike,
  type HttpOptions,
} from "./http";
export * as sleeper from "./sleeper";
export * as espn from "./espn";
export * as nflverse from "./nflverse";
export * as fantasypros from "./fantasypros";

import { fantasyProsProjectionProvider } from "./fantasypros";
import { sleeperProjectionProvider } from "./sleeper";
import type { ProjectionProvider } from "./types";

/**
 * Registered projection sources, most-preferred first. `internal.ingest.pull`
 * takes the first configured one; FantasyPros needs `FANTASYPROS_API_KEY` set
 * as a deployment environment variable.
 */
export const PROJECTION_PROVIDERS: readonly ProjectionProvider[] = [
  sleeperProjectionProvider,
  fantasyProsProjectionProvider,
];

export function defaultProjectionProvider(): ProjectionProvider {
  return PROJECTION_PROVIDERS.find((p) => p.isConfigured()) ?? sleeperProjectionProvider;
}

export function projectionProviderBySource(source: string): ProjectionProvider | undefined {
  return PROJECTION_PROVIDERS.find((p) => p.source === source);
}
