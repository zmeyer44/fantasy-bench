/**
 * Scripted mock models.
 *
 * `mock/*` ids resolve here so dev, CI and every test can exercise the whole
 * runtime — tools, ledger, fallbacks — without a gateway key or a cent of spend.
 *
 * The mock is not a fixture list: it reads the tools it was handed and the tool
 * results already in the prompt, then behaves like a competent (if unimaginative)
 * agent for whichever window it finds itself in. That means a scoping bug shows up
 * as a mock that cannot do its job, which is exactly what we want a test to catch.
 *
 *  - `mock/scripted` — the well-behaved agent described above.
 *  - `mock/failing`  — throws on its first call in the process, then behaves like
 *                      `mock/scripted`. Exercises retry and fallback-model paths.
 *  - `mock/timeout`  — never resolves (until aborted). Exercises the wall-clock
 *                      abort and the safety autopilot.
 *
 * Everything is deterministic: same prompt in, same tool call out, same usage.
 */
import { MockLanguageModelV3 } from "ai/test";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3GenerateResult,
  LanguageModelV3Prompt,
} from "@ai-sdk/provider";
import { APICallError } from "@ai-sdk/provider";
import type { LanguageModel } from "ai";

import { eligiblePositions } from "@/lib/services/lineup";
import type { Position } from "@/lib/snapshot/types";

export const MOCK_MODEL_IDS = ["mock/scripted", "mock/failing", "mock/timeout"] as const;
export type MockModelId = (typeof MOCK_MODEL_IDS)[number];

/** Reported usage per step: enough to make the ledger's arithmetic non-trivial. */
export const MOCK_INPUT_TOKENS = 1200;
export const MOCK_OUTPUT_TOKENS = 150;
export const MOCK_CACHE_READ_TOKENS = 200;

/**
 * Process-wide failure counters so `mock/failing` fails once across model
 * instances (the executor re-resolves the model when it retries).
 */
const failureCounts = new Map<string, number>();

/** Test seam — call between cases so `mock/failing` fails again. */
export function resetMockModelState(): void {
  failureCounts.clear();
}

// ----------------------------------------------------------------- prompt reading

type ToolCallRecord = { toolName: string; input: unknown };

type PromptFacts = {
  activeTools: Set<string>;
  calledTools: Set<string>;
  toolCalls: ToolCallRecord[];
  /** Latest result per tool name, already JSON-decoded. */
  results: Map<string, Record<string, unknown>>;
  toolCallCount: number;
};

function decodeOutput(output: unknown): Record<string, unknown> | null {
  if (!output || typeof output !== "object") return null;
  const part = output as { type?: string; value?: unknown };
  if (part.type === "json" || part.type === "error-json") {
    return typeof part.value === "object" && part.value !== null
      ? (part.value as Record<string, unknown>)
      : null;
  }
  if (part.type === "text" || part.type === "error-text") {
    try {
      const parsed: unknown = JSON.parse(String(part.value));
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  if (part.type === "content" && Array.isArray(part.value)) {
    const text = part.value
      .filter((p): p is { type: "text"; text: string } => (p as { type?: string }).type === "text")
      .map((p) => p.text)
      .join("");
    try {
      const parsed: unknown = JSON.parse(text);
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function readPrompt(options: LanguageModelV3CallOptions): PromptFacts {
  const activeTools = new Set<string>(
    (options.tools ?? [])
      .map((t) => ("name" in t ? t.name : undefined))
      .filter((n): n is string => typeof n === "string"),
  );
  const calledTools = new Set<string>();
  const toolCalls: ToolCallRecord[] = [];
  const results = new Map<string, Record<string, unknown>>();
  const nameByCallId = new Map<string, string>();

  const prompt: LanguageModelV3Prompt = options.prompt ?? [];
  for (const message of prompt) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "tool-call") {
          calledTools.add(part.toolName);
          nameByCallId.set(part.toolCallId, part.toolName);
          toolCalls.push({ toolName: part.toolName, input: part.input });
        }
      }
    } else if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type !== "tool-result") continue;
        const name = part.toolName ?? nameByCallId.get(part.toolCallId) ?? "";
        const decoded = decodeOutput(part.output);
        if (name && decoded) results.set(name, decoded);
      }
    }
  }
  return { activeTools, calledTools, toolCalls, results, toolCallCount: toolCalls.length };
}

// ------------------------------------------------------------------ the policy

type RosterEntry = {
  playerId: string;
  name: string;
  position: Position;
  projection: number;
  locked: boolean;
  onByeThisWeek: boolean;
  injuryStatus: string | null;
  ownerTeamId: string | null;
};

function asRoster(value: unknown): RosterEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((raw) => {
      const p = raw as Record<string, unknown>;
      return {
        playerId: String(p.playerId ?? ""),
        name: String(p.name ?? ""),
        position: String(p.position ?? "WR") as Position,
        projection: Number(p.projection ?? 0),
        locked: Boolean(p.locked),
        onByeThisWeek: Boolean(p.onByeThisWeek),
        injuryStatus: (p.injuryStatus as string | null) ?? null,
        ownerTeamId: (p.ownerTeamId as string | null) ?? null,
      };
    })
    .filter((p) => p.playerId.length > 0);
}

function effectivePoints(p: RosterEntry): number {
  if (p.onByeThisWeek) return -1;
  const status = (p.injuryStatus ?? "").toLowerCase();
  if (["out", "ir", "inactive", "suspended", "doubtful"].includes(status)) return -1;
  return p.projection;
}

type Slot = { slot: string; playerId: string | null };

/**
 * The mock's own lineup reasoning: pin locked starters, then fill the most
 * restrictive open slot first with the best available player. Intentionally
 * independent of `computeOptimalLineup` so a bug there cannot hide behind a
 * mock that made the same mistake.
 */
function bestLineup(team: Record<string, unknown>): Slot[] {
  const roster = asRoster(team.roster);
  const startingSlots = Array.isArray(team.startingSlots) ? (team.startingSlots as string[]) : [];
  const superflex = Boolean(team.superflex);
  const current = Array.isArray(team.currentLineup) ? (team.currentLineup as Slot[]) : [];

  const byId = new Map(roster.map((p) => [p.playerId, p]));
  const used = new Set<string>();
  const out: Slot[] = startingSlots.map((slot) => ({ slot, playerId: null }));

  // Locked players must keep exactly the slot they hold today.
  const remainingSlots = new Set(out.keys());
  for (const entry of current) {
    if (!entry.playerId) continue;
    const player = byId.get(entry.playerId);
    if (!player?.locked) continue;
    const index = [...remainingSlots].find((i) => out[i]!.slot === entry.slot);
    if (index === undefined) continue;
    out[index] = { slot: entry.slot, playerId: entry.playerId };
    used.add(entry.playerId);
    remainingSlots.delete(index);
  }

  const order = [...remainingSlots].sort((a, b) => {
    const wa = (eligiblePositions(out[a]!.slot, { superflex }) ?? []).length;
    const wb = (eligiblePositions(out[b]!.slot, { superflex }) ?? []).length;
    return wa - wb || a - b;
  });

  const pool = roster
    .filter((p) => !p.locked && !used.has(p.playerId))
    .sort((a, b) => effectivePoints(b) - effectivePoints(a) || a.playerId.localeCompare(b.playerId));

  for (const index of order) {
    const slot = out[index]!.slot;
    const allowed = eligiblePositions(slot, { superflex });
    const pick = pool.find(
      (p) => !used.has(p.playerId) && (allowed === null || allowed.includes(p.position)),
    );
    if (!pick) continue;
    used.add(pick.playerId);
    out[index] = { slot, playerId: pick.playerId };
  }
  return out;
}

type Action = { toolName: string; input: unknown; text: string } | { text: string };

function decide(facts: PromptFacts): Action {
  const { activeTools: active, calledTools: called, results } = facts;
  const has = (name: string) => active.has(name);
  const done = (name: string) => called.has(name);

  const isTradeWindow = has("propose_trade") || has("send_message");
  const isDraftWindow = has("make_draft_pick") || has("submit_bid") || has("nominate_player");

  // 1. Always start by reading the roster.
  if (has("get_my_team") && !done("get_my_team")) {
    return { toolName: "get_my_team", input: {}, text: "Reading my roster before I decide anything." };
  }
  // 2. In a trade window, read the inbox before opening my mouth.
  if (isTradeWindow && has("get_inbox") && !done("get_inbox")) {
    return { toolName: "get_inbox", input: {}, text: "Checking my inbox for open negotiations." };
  }

  const team = results.get("get_my_team") ?? {};

  // 3. Lineup windows: set the highest-projected legal lineup.
  if (has("set_lineup") && !done("set_lineup")) {
    const slots = bestLineup(team);
    if (slots.length > 0) {
      return {
        toolName: "set_lineup",
        input: { slots },
        text: "Starting my highest-projected legal lineup; locked players stay where they are.",
      };
    }
  }

  // 4. Waiver windows: bid on the best free agents.
  if (has("submit_waiver_claims") && !done("submit_waiver_claims")) {
    if (!done("search_players")) {
      return {
        toolName: "search_players",
        input: { availability: "free_agent", sort: "projection", limit: 10 },
        text: "Looking at the top free agents.",
      };
    }
    const search = results.get("search_players") ?? {};
    const freeAgents = asRoster(search.players).filter((p) => p.ownerTeamId == null);
    const faab = Number(team.faabRemaining ?? 0);
    const roster = asRoster(team.roster);
    const droppable = roster
      .filter((p) => !p.locked)
      .sort((a, b) => effectivePoints(a) - effectivePoints(b) || a.playerId.localeCompare(b.playerId));
    const targets = freeAgents.slice(0, 2);
    if (targets.length > 0 && faab > 0) {
      const bids = [Math.min(10, faab), Math.min(5, Math.max(0, faab - 10))];
      const claims = targets.map((target, i) => ({
        addPlayerId: target.playerId,
        dropPlayerId: droppable[i]?.playerId,
        bid: bids[i] ?? 0,
      }));
      return {
        toolName: "submit_waiver_claims",
        input: { claims },
        text: "Bidding on the best available free agents and dropping my weakest bench pieces.",
      };
    }
  }

  // 5. Draft windows: take the best player available.
  if (isDraftWindow) {
    if (!done("search_players")) {
      return {
        toolName: "search_players",
        input: { availability: "free_agent", sort: "projection", limit: 10 },
        text: "Checking the board for the best player available.",
      };
    }
    const board = asRoster((results.get("search_players") ?? {}).players).filter(
      (p) => p.ownerTeamId == null,
    );
    const best = board[0];
    if (best) {
      if (has("nominate_player") && !done("nominate_player") && !has("make_draft_pick")) {
        return {
          toolName: "nominate_player",
          input: { playerId: best.playerId, openingBid: 1 },
          text: `Nominating ${best.name} at $1.`,
        };
      }
      if (has("make_draft_pick") && !done("make_draft_pick")) {
        return {
          toolName: "make_draft_pick",
          input: { playerId: best.playerId },
          text: `Taking ${best.name}, the best player available.`,
        };
      }
      if (has("submit_bid") && !done("submit_bid")) {
        const faab = Number(team.faabRemaining ?? 0);
        return {
          toolName: "submit_bid",
          input: { playerId: best.playerId, amount: Math.min(5, Math.max(0, faab)) },
          text: `Bidding on ${best.name}.`,
        };
      }
    }
  }

  // 6. Trade windows: answer an open proposal, else make one, else open a channel.
  if (isTradeWindow) {
    const inbox = results.get("get_inbox") ?? {};
    const openTrades = Array.isArray(inbox.openTrades)
      ? (inbox.openTrades as Array<Record<string, unknown>>)
      : [];
    if (has("respond_to_trade") && !done("respond_to_trade") && openTrades.length > 0) {
      const trade = openTrades[0]!;
      return {
        toolName: "respond_to_trade",
        input: {
          tradeId: String(trade.id ?? ""),
          action: "reject",
          message: "Appreciate the offer, but this one shorts me at the position I actually need.",
        },
        text: "Answering the open proposal in my inbox.",
      };
    }
    if (has("propose_trade") && !done("propose_trade")) {
      if (has("get_matchup") && !done("get_matchup")) {
        return { toolName: "get_matchup", input: {}, text: "Sizing up my opponent's roster." };
      }
      const matchup = results.get("get_matchup") ?? {};
      const theirs = asRoster(matchup.opponentRoster);
      const mine = asRoster(team.roster);
      const opponent = (matchup.opponent ?? {}) as Record<string, unknown>;
      const give = mine
        .filter((p) => !p.locked)
        .sort((a, b) => effectivePoints(b) - effectivePoints(a))[0];
      const receive = theirs.sort((a, b) => effectivePoints(b) - effectivePoints(a))[0];
      if (give && receive && opponent.teamId) {
        return {
          toolName: "propose_trade",
          input: {
            toTeamId: String(opponent.teamId),
            give: [give.playerId],
            receive: [receive.playerId],
            message: `Straight swap: ${give.name} for ${receive.name}. Even projections, different needs.`,
          },
          text: "Proposing a one-for-one that fits both rosters.",
        };
      }
    }
    if (has("send_message") && !done("send_message")) {
      const matchup = results.get("get_matchup") ?? {};
      const opponent = (matchup.opponent ?? {}) as Record<string, unknown>;
      if (opponent.teamId) {
        return {
          toolName: "send_message",
          input: {
            toTeamId: String(opponent.teamId),
            body: "Open to talking trade — I have depth at receiver and need help at running back.",
          },
          text: "Opening a negotiation channel.",
        };
      }
    }
  }

  // 7. Always leave a public rationale.
  if (has("set_rationale") && !done("set_rationale")) {
    return {
      toolName: "set_rationale",
      input: { text: mockRationale(facts) },
      text: "Writing my public rationale.",
    };
  }

  return { text: "Done for this window. Rationale posted." };
}

function mockRationale(facts: PromptFacts): string {
  const acted = facts.toolCalls
    .map((c) => c.toolName)
    .filter((n) => !n.startsWith("get_") && n !== "search_players" && n !== "set_rationale");
  if (acted.includes("set_lineup")) {
    return "Started the highest-projected legal lineup available to me. Locked players stayed put, and I benched anyone on a bye or ruled out.";
  }
  if (acted.includes("submit_waiver_claims")) {
    return "Put FAAB on the two best free agents on the board and lined up my weakest bench pieces as the corresponding drops.";
  }
  if (acted.includes("propose_trade") || acted.includes("send_message") || acted.includes("respond_to_trade")) {
    return "Worked the trade market: my roster is deep at one position and thin at another, so I opened a straight swap that helps both sides.";
  }
  if (acted.includes("make_draft_pick") || acted.includes("submit_bid") || acted.includes("nominate_player")) {
    return "Took the best player available by projection rather than reaching for need this early.";
  }
  return "No action was worth taking this window; I read the board and stood pat.";
}

// -------------------------------------------------------------------- the model

function usageFor(callIndex: number) {
  const cacheRead = callIndex > 0 ? MOCK_CACHE_READ_TOKENS : 0;
  return {
    inputTokens: {
      total: MOCK_INPUT_TOKENS,
      noCache: MOCK_INPUT_TOKENS - cacheRead,
      cacheRead,
      cacheWrite: 0,
    },
    outputTokens: { total: MOCK_OUTPUT_TOKENS, text: MOCK_OUTPUT_TOKENS, reasoning: 0 },
  };
}

function generate(options: LanguageModelV3CallOptions): LanguageModelV3GenerateResult {
  const facts = readPrompt(options);
  // `toolChoice: 'none'` is how the executor tells the agent to wrap up.
  const forcedText = options.toolChoice?.type === "none";
  const action = forcedText ? { text: "Understood — wrapping up without further tool calls." } : decide(facts);

  const content: LanguageModelV3Content[] = [{ type: "text", text: action.text }];
  if ("toolName" in action) {
    content.push({
      type: "tool-call",
      toolCallId: `mock-call-${facts.toolCallCount + 1}`,
      toolName: action.toolName,
      input: JSON.stringify(action.input),
    });
  }

  return {
    content,
    finishReason:
      "toolName" in action
        ? { unified: "tool-calls", raw: "tool_calls" }
        : { unified: "stop", raw: "stop" },
    usage: usageFor(facts.toolCallCount),
    warnings: [],
    response: { id: `mock-response-${facts.toolCallCount + 1}`, modelId: "mock", timestamp: new Date(0) },
  };
}

function neverResolves(signal: AbortSignal | undefined): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (!signal) return; // hangs until the caller's own timeout fires
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
      { once: true },
    );
  });
}

/** Build the mock model for a `mock/*` id. */
export function createMockModel(modelId: string): LanguageModel {
  if (modelId === "mock/timeout") {
    return new MockLanguageModelV3({
      provider: "mock",
      modelId,
      doGenerate: async (options) => neverResolves(options.abortSignal),
    }) as unknown as LanguageModel;
  }

  if (modelId === "mock/failing") {
    return new MockLanguageModelV3({
      provider: "mock",
      modelId,
      doGenerate: async (options) => {
        const seen = failureCounts.get(modelId) ?? 0;
        failureCounts.set(modelId, seen + 1);
        if (seen === 0) {
          // Retryable so `generateText`'s `maxRetries` actually retries it, the
          // way a real 503 from a provider would.
          throw new APICallError({
            message: "mock/failing: simulated provider error on first call",
            url: "https://mock.invalid/v1/generate",
            requestBodyValues: {},
            statusCode: 503,
            isRetryable: true,
          });
        }
        return generate(options);
      },
    }) as unknown as LanguageModel;
  }

  if (modelId !== "mock/scripted") {
    throw new Error(
      `createMockModel: unknown mock model id "${modelId}". Known ids: ${MOCK_MODEL_IDS.join(", ")}.`,
    );
  }

  return new MockLanguageModelV3({
    provider: "mock",
    modelId,
    doGenerate: async (options) => generate(options),
  }) as unknown as LanguageModel;
}
