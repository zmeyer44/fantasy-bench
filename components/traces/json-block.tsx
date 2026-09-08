import { cn } from "@/components/ui";

const MAX_CHARS = 24_000;

/**
 * Pretty-printed JSON in a scrolling `<pre>`. Rendered on the server — the
 * trace viewer must paint a 30-step run without shipping a syntax highlighter.
 */
export function JsonBlock({
  value,
  className,
  tone = "default",
}: {
  value: unknown;
  className?: string;
  tone?: "default" | "error";
}) {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  const truncated = text.length > MAX_CHARS;
  const body = truncated ? `${text.slice(0, MAX_CHARS)}\n… truncated` : text;

  return (
    <pre
      className={cn(
        "max-h-96 overflow-auto rounded-md border px-3 py-2 font-mono text-[11px] leading-relaxed",
        tone === "error"
          ? "border-danger/40 bg-danger/10 text-ink"
          : "border-line bg-surface-muted text-ink-muted",
        className,
      )}
    >
      {body}
    </pre>
  );
}
