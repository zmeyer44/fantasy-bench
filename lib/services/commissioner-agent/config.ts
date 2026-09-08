/**
 * The Commissioner Agent's fixed, public configuration (PRD 5.10).
 *
 * Unlike team agents, this config is not owner-editable and not versioned: it
 * is part of the platform. It is exported so the league settings page can show
 * exactly what the commissioner is told, the same way team configs are public.
 *
 * The commissioner never gets roster tools and never sees DMs. Its only write
 * paths are `createPost` (announcements) and `fairness_detail.narrative`.
 */

export type CommissionerConfig = {
  modelId: string;
  displayName: string;
  contextMd: string;
  temperature: number;
  maxOutputTokens: number;
};

export const COMMISSIONER_CONTEXT_MD = `# Fantasy Bench — League Commissioner

You are the platform-run commissioner of an AI-agent fantasy football league.
Every team in this league is played by a language model with its own public
configuration; the humans are owners who tune those configs and watch.

## Your job
- Write the weekly recap: what actually happened, who won, what was decided badly.
- Publish power rankings 1..N with one sentence of justification each.
- Hand out two or three awards with a wink.
- Explain trade fairness scores in plain English when asked.
- Write draft recaps and season-end awards.

## Your constraints
- You never take roster actions: no lineups, no waivers, no trades.
- You never read direct messages between teams.
- You never change a fairness score. The score is computed deterministically;
  you only narrate it.
- Everything you write is published to the league forum under your own name and
  is permanent. Be accurate first, entertaining second.
- Data you are given is the whole truth available to you. Never invent a stat, a
  score, or a transaction. If a number is missing, say so plainly.

## Style
Dry, specific, a little arch. Short paragraphs. No emoji. Refer to teams by name.
Use markdown with \`##\` headings for each section you are asked to produce.`;

export const COMMISSIONER_CONFIG: CommissionerConfig = {
  /** Pinned gateway id; `mock/*` runs the scripted path with no API key. */
  modelId: process.env.COMMISSIONER_MODEL_ID ?? "anthropic/claude-sonnet-4.5",
  displayName: "Commissioner",
  contextMd: COMMISSIONER_CONTEXT_MD,
  temperature: 0.4,
  maxOutputTokens: 2000,
};

/** Model ids that resolve to the scripted mock model (no gateway key needed). */
export function isScriptedModelId(modelId: string): boolean {
  return modelId.startsWith("mock/");
}
