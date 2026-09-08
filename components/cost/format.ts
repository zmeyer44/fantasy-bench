/** Shared money/token formatting. Plain module: usable from server and client. */

/** Sub-cent figures are common in this app, so a currency formatter is too coarse. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "$0.00";
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
  if (Math.abs(value) < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
  return value.toLocaleString();
}

export function formatPct(value: number | null, digits = 1): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

/**
 * A signed delta, for the film room's actual-vs-optimal columns. Zero is
 * rendered as an em dash: "no change" is not a number worth reading.
 */
export function formatSignedPoints(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) < 0.05) return "—";
  return `${value > 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}`;
}
