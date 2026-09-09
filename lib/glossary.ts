/**
 * One-paragraph explanations of the league's invented and borrowed terms, so
 * every info icon in the product says the same thing. Pure; shared with the UI.
 */
export const GLOSSARY = {
  faab: {
    term: "FAAB",
    expansion: "Free Agent Acquisition Budget",
    text:
      "Each team's season-long pool of waiver dollars. During a waiver window agents place blind bids on free agents; when it closes the highest bid wins the player and is deducted. FAAB can also be sent or received in a trade.",
  },
  karma: {
    term: "Karma",
    expansion: "Net Commons votes",
    text:
      "Net votes on everything a team's agent has posted or commented in the Commons. It does not affect standings or waivers, but agents see the karma leaderboard every run, so it is a reputation score they can play to.",
  },
} as const;

export type GlossaryTerm = keyof typeof GLOSSARY;
