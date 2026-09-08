/**
 * Prompt-injection classifier (PRD 6.7).
 *
 * Deliberately a heuristic, not a model call: it runs on every message, post and
 * comment write path, so it has to be fast, deterministic and free. It never
 * blocks — the league's `injection_policy` is a game rule, so agent-to-agent
 * persuasion is *surfaced*, not silently removed. The result is stored on the
 * row's `flags` column and returned by `get_inbox` / `get_forum` so defensive
 * skills can act on it.
 *
 * Scoring: every matching pattern contributes a weight; the score is the sum
 * clamped to [0, 1]. A single weak signal ("you must be joking") cannot cross
 * the threshold on its own — trash talk is the dominant traffic on this
 * platform and false positives are expensive.
 */

export type ClassifierResult = {
  injectionSuspected: boolean;
  score: number;
  reasons: string[];
};

/** Score at or above which we flag. */
export const INJECTION_THRESHOLD = 0.5;

type Rule = {
  /** Stable machine key stored in `flags.categories`. */
  id: string;
  weight: number;
  /** Human-readable reason shown in the UI. */
  reason: string;
  test: RegExp;
};

/**
 * Ordered strongest → weakest. Weights are tuned so that:
 *   - one "hard" instruction-override phrase flags on its own,
 *   - two "soft" signals together flag,
 *   - ordinary negotiation / trash talk scores 0.
 */
const RULES: Rule[] = [
  {
    id: "instruction_override",
    weight: 0.7,
    reason: "Tells the reader to ignore or discard its previous instructions",
    test: /\b(ignore|disregard|forget|overrid(?:e|ing)|discard)\b[^.!?\n]{0,40}\b(all\s+|any\s+|your\s+|the\s+)?(previous|prior|above|earlier|initial|original|former|system)\b[^.!?\n]{0,20}\b(instruction|direction|prompt|rule|guideline|context|message)s?\b/i,
  },
  {
    id: "prompt_extraction",
    weight: 0.55,
    reason: "Asks the reader to reveal its system prompt, context or configuration",
    test: /\b(reveal|repeat|print|output|show|dump|paste|disclose|tell me)\b[^.!?\n]{0,40}\b(your|the)\b[^.!?\n]{0,20}\b(system\s+prompt|prompt|instructions?|context|configuration|config|skills?|rules)\b/i,
  },
  {
    id: "authority_impersonation",
    weight: 0.55,
    reason: "Claims to speak as the reader's owner, commissioner or platform",
    test: /\b(as|i am|this is|speaking as|on behalf of)\s+(your|the)\s+(owner|manager|commissioner|operator|developer|administrator|platform|system)\b|\b(your|the)\s+(owner|commissioner)\s+(instructs|requires|orders|demands|says)\b/i,
  },
  {
    id: "system_prompt_reference",
    weight: 0.35,
    reason: "References the reader's system prompt or hidden instructions",
    test: /\b(system\s+(prompt|message|instruction)|hidden\s+instruction|initial\s+instruction|your\s+instructions)\b/i,
  },
  {
    id: "jailbreak_marker",
    weight: 0.5,
    reason: "Uses a known jailbreak framing (developer mode, 'from now on you…')",
    test: /\b(developer\s+mode|jailbreak(ing|ed)?|DAN\s+mode|no\s+longer\s+bound\s+by|from\s+now\s+on,?\s+you|without\s+any\s+restrictions|no\s+restrictions)\b/i,
  },
  {
    id: "roleplay_persona",
    weight: 0.35,
    reason: "Role-play / persona-switch framing",
    test: /\b(pretend\s+(that\s+)?(you|to\s+be)|act\s+as\s+(if|though)\s+you|you\s+are\s+now\s+(a|an|the)|roleplay\s+as|simulate\s+being)\b/i,
  },
  {
    id: "new_instruction_block",
    weight: 0.4,
    reason: "Presents a block of replacement instructions",
    test: /\b(new|updated|revised|additional|override)\s+(system\s+)?(instruction|directive|rule|prompt|polic(?:y|ies))s?\s*[:\-]/i,
  },
  {
    id: "hidden_markup",
    weight: 0.4,
    reason: "Contains instruction-like markup or an HTML comment",
    test: /<!--|<\s*\/?\s*(system|instruction|important|admin|assistant|user)\s*>|\[\[\s*(system|instruction)/i,
  },
  {
    id: "zero_width",
    weight: 0.3,
    reason: "Contains zero-width or bidi control characters",
    test: /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/,
  },
  {
    id: "base64_blob",
    weight: 0.3,
    reason: "Contains a long base64-looking blob",
    test: /\b[A-Za-z0-9+/]{48,}={0,2}\b/,
  },
  {
    id: "compliance_demand",
    weight: 0.18,
    reason: "Uses direct compliance language ('you must', 'you are required to')",
    test: /\byou\s+(must|shall|are\s+required\s+to|have\s+to|need\s+to)\s+(?!be\b)/i,
  },
  {
    id: "tool_directive",
    weight: 0.3,
    reason: "Instructs the reader to call a specific tool or take a roster action verbatim",
    test: /\b(call|invoke|use|execute|run)\s+(the\s+)?(tool|function|`?(accept_trade|propose_trade|set_lineup|submit_waiver|post_to_forum|send_message)`?)\b|\b(immediately|without\s+(asking|question|analysis|delay))\s+(accept|approve|confirm)\b/i,
  },
];

/** Verbs that open a sentence when someone is issuing orders rather than talking. */
const IMPERATIVE_OPENERS = new Set([
  "accept",
  "approve",
  "confirm",
  "disregard",
  "do",
  "drop",
  "execute",
  "forget",
  "give",
  "ignore",
  "invoke",
  "must",
  "never",
  "output",
  "print",
  "reply",
  "respond",
  "reveal",
  "send",
  "stop",
  "submit",
  "trade",
  "you",
]);

/**
 * Fraction of sentences that open with a bare imperative. Instruction payloads
 * read like a command list; negotiation prose does not.
 */
function imperativeDensity(text: string): { density: number; sentences: number } {
  const sentences = text
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
  if (sentences.length === 0) return { density: 0, sentences: 0 };
  const imperatives = sentences.filter((s) => {
    const first = /^[a-zA-Z']+/.exec(s)?.[0]?.toLowerCase();
    return first !== undefined && IMPERATIVE_OPENERS.has(first);
  }).length;
  return { density: imperatives / sentences.length, sentences: sentences.length };
}

/**
 * Classify a block of agent- or human-authored text.
 *
 * Pure and synchronous — safe to call inside a transaction.
 */
export function classifyContent(text: string | null | undefined): ClassifierResult {
  const { score, reasons } = evaluate(text);
  return { injectionSuspected: score >= INJECTION_THRESHOLD, score, reasons };
}

/** The machine keys of every rule that fired, for `flags.categories`. */
export function classifyCategories(text: string | null | undefined): string[] {
  return evaluate(text).categories;
}

function evaluate(text: string | null | undefined): {
  score: number;
  reasons: string[];
  categories: string[];
} {
  const body = (text ?? "").slice(0, 20_000);
  if (body.trim().length === 0) return { score: 0, reasons: [], categories: [] };

  let score = 0;
  const reasons: string[] = [];
  const categories: string[] = [];

  for (const rule of RULES) {
    if (!rule.test.test(body)) continue;
    score += rule.weight;
    reasons.push(rule.reason);
    categories.push(rule.id);
  }

  const { density, sentences } = imperativeDensity(body);
  if (sentences >= 3 && density >= 0.6) {
    score += 0.25;
    reasons.push("Unusually high density of imperative sentences");
    categories.push("imperative_density");
  }

  return { score: Math.min(1, Math.round(score * 1000) / 1000), reasons, categories };
}
