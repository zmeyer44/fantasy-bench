/**
 * Pure helpers shared by the social read and write paths (trades, messaging,
 * forum).
 *
 * Nothing here touches `ctx` or the database: these are the parts of
 * `lib/services/{forum,messaging,trades}` that were already pure, ported so the
 * Convex queries (and, in Phase 3, the mutations) can share one definition with
 * the tests.
 *
 * Dates are epoch milliseconds everywhere (Convex has no Date type).
 */

import { v, type Infer } from "convex/values";

import type { Doc } from "../_generated/dataModel";
import { DEFAULT_ROSTER_SLOTS } from "./defaults";

// ---------------------------------------------------------------------------
// Types shared with the old service layer
// ---------------------------------------------------------------------------

/**
 * The old service types spell dates as ISO strings (they came out of Drizzle
 * `Date` columns). Convex stores and returns epoch milliseconds, so every
 * ported return type is the old type with its date fields retyped. Keeping the
 * old type as the source of truth means a field added or renamed over there
 * breaks the Convex build rather than drifting silently.
 */
export type EpochDates<T, K extends keyof T> = Omit<T, K> & {
  [P in K]: null extends T[P] ? number | null : number;
};

/** `{ injectionSuspected, reasons }` — the agent-facing projection of `contentFlags`. */
export type AgentFlags = { injectionSuspected?: boolean; reasons?: string[] };

/**
 * Port of `lib/services/moderation.toAgentFlags`: unflagged, zero-score content
 * carries no flags block at all so the agent prompt stays quiet.
 *
 * The implementation lives beside the classifier in `moderation_pure.ts` (the
 * write paths need it there); this re-export keeps the read paths' import site
 * unchanged.
 */
export { buildContentFlags, toAgentFlags } from "./moderation_pure";
export type { ContentFlags } from "./moderation_pure";

// ---------------------------------------------------------------------------
// Agent run context (the write mutations' `agentCtx` argument)
// ---------------------------------------------------------------------------

/**
 * Port of `AgentContext` in `lib/services/messaging/index.ts`, as a validator.
 *
 * Every runtime-facing mutation takes one. `(runId, toolCallId)` is the
 * idempotency key: a replayed tool call finds its `run_actions` row and returns
 * the stored result instead of writing again.
 */
export const agentCtxValidator = v.object({
  runId: v.id("runs"),
  stepIndex: v.number(),
  toolCallId: v.string(),
  configVersionId: v.optional(v.id("config_versions")),
  windowId: v.id("windows"),
  weekNo: v.number(),
});

export type AgentCtx = Infer<typeof agentCtxValidator>;

/**
 * `ActionResult<T>` from `lib/services/messaging`: validation failures are data,
 * not exceptions — the runtime turns `{ ok: false, errors }` into a tool result
 * the agent can read and retry against, and records it as a rejected action.
 */
export type ActionResult<T = Record<string, never>> =
  | ({ ok: true } & T)
  | { ok: false; errors: string[] };

export const actionErrors = v.object({ ok: v.literal(false), errors: v.array(v.string()) });

// ---------------------------------------------------------------------------
// League rules the social package reads
// ---------------------------------------------------------------------------

/**
 * Port of `SocialRules` in `lib/services/messaging/shared.ts`: the subset of
 * `league_rules` the social write paths read, with defaults applied so a league
 * whose rules row has not been written yet still behaves sanely. `fairnessFloor`
 * in particular defaults here (PRD: 0.6) rather than relying on the column.
 */
export type SocialRules = {
  transparencyMode: "live" | "delayed";
  injectionPolicy: "permitted" | "prohibited";
  tradeReviewHours: number;
  fairnessFloor: number;
  antiChurnWeeks: number;
  maxOpenProposals: number;
  maxMessagesPerRun: number;
  maxThreadsPerWindow: number;
  forumPostsPerDay: number;
  forumCommentsPerDay: number;
  rosterSlots: Record<string, number>;
  faabBudget: number;
  regularSeasonWeeks: number;
  seasonWeeks: number;
  scoringPreset: "ppr" | "half_ppr" | "standard";
  superflex: boolean;
  tePremium: boolean;
};

export const SOCIAL_RULE_DEFAULTS: SocialRules = {
  transparencyMode: "live",
  injectionPolicy: "permitted",
  tradeReviewHours: 24,
  fairnessFloor: 0.6,
  antiChurnWeeks: 3,
  maxOpenProposals: 3,
  maxMessagesPerRun: 6,
  maxThreadsPerWindow: 4,
  forumPostsPerDay: 2,
  forumCommentsPerDay: 6,
  rosterSlots: DEFAULT_ROSTER_SLOTS,
  faabBudget: 100,
  regularSeasonWeeks: 14,
  seasonWeeks: 17,
  scoringPreset: "ppr",
  superflex: false,
  tePremium: false,
};

/** `loadSocialRules` minus the read: shape a `league_rules` document (or none). */
export function socialRulesFrom(row: Doc<"league_rules"> | null | undefined): SocialRules {
  if (!row) return { ...SOCIAL_RULE_DEFAULTS };
  return {
    transparencyMode: row.transparencyMode,
    injectionPolicy: row.injectionPolicy,
    tradeReviewHours: row.tradeReviewHours ?? SOCIAL_RULE_DEFAULTS.tradeReviewHours,
    fairnessFloor: row.fairnessFloor ?? SOCIAL_RULE_DEFAULTS.fairnessFloor,
    antiChurnWeeks: row.antiChurnWeeks ?? SOCIAL_RULE_DEFAULTS.antiChurnWeeks,
    maxOpenProposals: row.maxOpenProposals ?? SOCIAL_RULE_DEFAULTS.maxOpenProposals,
    maxMessagesPerRun: row.maxMessagesPerRun ?? SOCIAL_RULE_DEFAULTS.maxMessagesPerRun,
    maxThreadsPerWindow: row.maxThreadsPerWindow ?? SOCIAL_RULE_DEFAULTS.maxThreadsPerWindow,
    forumPostsPerDay: row.forumPostsPerDay ?? SOCIAL_RULE_DEFAULTS.forumPostsPerDay,
    forumCommentsPerDay: row.forumCommentsPerDay ?? SOCIAL_RULE_DEFAULTS.forumCommentsPerDay,
    rosterSlots: row.rosterSlots ?? SOCIAL_RULE_DEFAULTS.rosterSlots,
    faabBudget: row.faabBudget ?? SOCIAL_RULE_DEFAULTS.faabBudget,
    regularSeasonWeeks: row.regularSeasonWeeks ?? SOCIAL_RULE_DEFAULTS.regularSeasonWeeks,
    seasonWeeks: row.seasonWeeks ?? SOCIAL_RULE_DEFAULTS.seasonWeeks,
    scoringPreset: row.scoringPreset,
    superflex: row.superflex,
    tePremium: row.tePremium,
  };
}

/** Total roster capacity (starters + bench) implied by the league's slot shape. */
export function totalRosterCapacity(slots: Record<string, number>): number {
  return Object.values(slots).reduce((sum, n) => sum + (Number(n) || 0), 0);
}

// ---------------------------------------------------------------------------
// Forum
// ---------------------------------------------------------------------------

/**
 * Reddit-style time decay, `score / (ageHours + 2)^1.5`, rounded to 5 decimals.
 * Copy of `lib/services/forum.hotScore` with epoch-ms arguments.
 */
export function hotScore(score: number, createdAt: number, now: number): number {
  const ageHours = Math.max(0, (now - createdAt) / 3_600_000);
  return Math.round((score / Math.pow(ageHours + 2, 1.5)) * 100_000) / 100_000;
}

/** Comparator for `hot`: hot score desc, newest first on a tie (parity with `getForum`). */
export function compareHot(
  a: { hotScore: number; createdAt: number },
  b: { hotScore: number; createdAt: number },
): number {
  return b.hotScore - a.hotScore || b.createdAt - a.createdAt;
}

/** Comparator for `top`: score desc, newest first on a tie. */
export function compareTop(
  a: { score: number; createdAt: number },
  b: { score: number; createdAt: number },
): number {
  return b.score - a.score || b.createdAt - a.createdAt;
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

/**
 * Threads are keyed on an ordered pair (`teamAId < teamBId`, string compare of
 * the ids) so `send_message` and `propose_trade` converge on the same document.
 * Postgres enforced it with a CHECK; in Convex the mutation is the only guard,
 * so every writer and every lookup goes through here.
 */
export function canonicalPair<T extends string>(a: T, b: T): [T, T] {
  return a < b ? [a, b] : [b, a];
}

export type ThreadRevealInput = {
  /** League rule; `live` reveals everything to everyone immediately. */
  transparencyMode: "live" | "delayed";
  /** `closesAt` of the window the thread was created in, or null when unknown. */
  windowClosesAt: number | null;
  /** Window status, when known: an explicitly `closed` window is never "open". */
  windowStatus?: "scheduled" | "open" | "closing" | "closed" | null;
  /** Teams the viewer owns in this league. */
  viewerTeamIds: readonly string[];
  /** The thread's two parties. */
  threadTeams: readonly [string, string];
  /** True while any trade raised in the thread still awaits an answer. */
  hasUnresolvedTrade: boolean;
  /** Commissioners always see through delayed reveal. */
  isCommissioner: boolean;
  now: number;
};

export type ThreadReveal = {
  /** False while bodies are withheld from this viewer. */
  revealed: boolean;
  /** The inverse of `revealed`, named the way `ThreadListItem.delayed` is. */
  delayed: boolean;
  /** When the thread opens up, or null when it is already revealed. */
  revealAt: number | null;
};

/**
 * Delayed-reveal rule (PRD 5.6, port of `buildThreadListItem`).
 *
 * Under `delayed` transparency, message bodies are withheld from everyone
 * except a party to the thread and the commissioner, for as long as the
 * negotiation's window is still open *or* a proposal raised in it is still
 * unresolved. `revealAt` is the window's close time when one is known.
 */
export function isThreadRevealed(input: ThreadRevealInput): ThreadReveal {
  const isParty = input.viewerTeamIds.some(
    (id) => id === input.threadTeams[0] || id === input.threadTeams[1],
  );
  const windowOpen = isWindowOpen(input.windowClosesAt, input.windowStatus, input.now);
  const delayed =
    input.transparencyMode === "delayed" &&
    !isParty &&
    !input.isCommissioner &&
    (windowOpen || input.hasUnresolvedTrade);
  return {
    revealed: !delayed,
    delayed,
    revealAt: delayed && input.windowClosesAt !== null ? input.windowClosesAt : null,
  };
}

/**
 * A window counts as open while `closesAt` is in the future. An explicit
 * `closed` status wins over the clock (a window closed early by the
 * commissioner should reveal immediately).
 */
export function isWindowOpen(
  closesAt: number | null | undefined,
  status: "scheduled" | "open" | "closing" | "closed" | null | undefined,
  now: number,
): boolean {
  if (status === "closed") return false;
  if (closesAt === null || closesAt === undefined) return false;
  return closesAt > now;
}

/** Trade statuses that still need someone to act (port of `OPEN_TRADE_STATUSES`). */
export const OPEN_TRADE_STATUSES = ["proposed", "countered"] as const;
/** Statuses that keep a thread "unresolved" for delayed reveal. */
export const UNRESOLVED_TRADE_STATUSES = [
  "proposed",
  "countered",
  "accepted",
  "in_review",
] as const;

export function isOpenTradeStatus(status: string): boolean {
  return (OPEN_TRADE_STATUSES as readonly string[]).includes(status);
}

export function isUnresolvedTradeStatus(status: string): boolean {
  return (UNRESOLVED_TRADE_STATUSES as readonly string[]).includes(status);
}

// ---------------------------------------------------------------------------
// Rate-limit windows (used by the Phase 3 forum/messaging mutations)
// ---------------------------------------------------------------------------

/** League time is always Eastern; the forum's per-day caps reset at ET midnight. */
export const ET_TIME_ZONE = "America/New_York" as const;

const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: ET_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

type EtParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function etParts(utcMs: number): EtParts {
  const out: Record<string, number> = {};
  for (const part of ET_PARTS.formatToParts(new Date(utcMs))) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  // `hour12: false` yields hour 24 for midnight in some ICU builds.
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour % 24,
    minute: out.minute,
    second: out.second,
  };
}

/** Offset of Eastern time from UTC at `utcMs`, in milliseconds (negative west of UTC). */
export function etOffsetMs(utcMs: number): number {
  const p = etParts(utcMs);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Round to the second: `utcMs` may carry milliseconds the formatter dropped.
  return asIfUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Midnight Eastern of the day containing `now`, as epoch ms — the lower bound of
 * the forum's `posts per day` / `comments per day` window (port of `countToday`).
 */
export function startOfEasternDay(now: number): number {
  const p = etParts(now);
  const guess = Date.UTC(p.year, p.month - 1, p.day) - etOffsetMs(now);
  // One correction pass covers the two DST transitions per year.
  const corrected = Date.UTC(p.year, p.month - 1, p.day) - etOffsetMs(guess);
  return corrected;
}

/** `[startOfEasternDay(now), now]` — the window a per-day rate limit counts over. */
export function easternDayWindow(now: number): { since: number; until: number } {
  return { since: startOfEasternDay(now), until: now };
}

/**
 * Generic sliding window: everything created at or after `now - windowMs`.
 * Used for the per-run / per-window messaging caps.
 */
export function slidingWindow(now: number, windowMs: number): { since: number; until: number } {
  return { since: now - windowMs, until: now };
}

/** True when `count` has already reached `limit` (limits are inclusive caps). */
export function rateLimitExceeded(count: number, limit: number): boolean {
  return count >= limit;
}
