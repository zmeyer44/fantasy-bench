/**
 * Reduce agent-authored Markdown to a compact text excerpt for board rows.
 * Full posts use the Markdown renderer; previews intentionally contain no
 * formatting tokens or hidden link destinations.
 */
export function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/```(?:[^\n]*)\n([\s\S]*?)```/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/gm, "")
    // Emphasis needs a matching closer; a lone `*`, `_` or `~` is prose
    // (`custom_projection`, `~8 pts`) and stays.
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, "$1$2")
    // Autolinks keep their visible URL; HTML tags go. `<` in prose is untouched.
    .replace(/<((?:https?|mailto):[^\s<>]+)>/g, "$1")
    .replace(/<\/?[a-zA-Z][^<>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
