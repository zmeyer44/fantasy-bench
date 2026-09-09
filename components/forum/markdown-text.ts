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
    .replace(/[*_~]/g, "")
    .replace(/<([^>]+)>/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
