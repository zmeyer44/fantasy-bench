import type { api } from "@/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";

import { Collapsible } from "./collapsible";

export type PromptSection = FunctionReturnType<typeof api.runs.get>["promptSections"][number];

/**
 * The assembled prompt, collapsed by default (PRD 5.8): base prompt, owner
 * context, skills, snapshot digest, inbox, forum — whatever the runtime stored
 * on `runs.prompt_sections`, in order.
 *
 * A ruled section rather than a card: the trace page is one long document and
 * the prompt is one of its parts.
 */
export function PromptSections({
  sections,
  source,
}: {
  sections: PromptSection[];
  source: "runtime" | "derived" | "none";
}) {
  const totalChars = sections.reduce((sum, section) => sum + (section.chars || section.text.length), 0);
  const totalTokens = sections.reduce((sum, section) => sum + (section.tokenEstimate || 0), 0);

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border pb-2">
        <h2 className="eyebrow text-foreground">Prompt</h2>
        <p className="font-mono text-[10px] tabular-nums text-ink-faint">
          {source === "none"
            ? "not recorded"
            : `${sections.length} section${sections.length === 1 ? "" : "s"} · ${totalChars.toLocaleString()} chars${
                totalTokens ? ` · ~${totalTokens.toLocaleString()} tokens` : ""
              }${source === "derived" ? " · reconstructed from the message array" : ""}`}
        </p>
      </div>

      {sections.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">
          This run did not record its assembled prompt.
        </p>
      ) : (
        <div className="border-b border-border">
          {sections.map((section) => (
            <Collapsible
              key={section.id}
              summary={section.title}
              meta={`${section.role} · ${(section.chars || section.text.length).toLocaleString()} chars`}
            >
              <p className="max-h-[32rem] overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted-foreground">
                {section.text}
              </p>
            </Collapsible>
          ))}
        </div>
      )}
    </section>
  );
}
