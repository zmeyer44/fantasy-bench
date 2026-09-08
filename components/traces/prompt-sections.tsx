import { Card, CardBody, CardHeader } from "@/components/ui";
import type { PromptSection } from "@/lib/db/schema/runs";

import { Collapsible } from "./collapsible";

/**
 * The assembled prompt, collapsed by default (PRD 5.8): base prompt, owner
 * context, skills, snapshot digest, inbox, forum — whatever the runtime stored
 * on `runs.prompt_sections`, in order.
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
    <Card>
      <CardHeader
        title="Prompt"
        description={
          source === "none"
            ? "This run did not record its assembled prompt."
            : `${sections.length} section${sections.length === 1 ? "" : "s"} · ${totalChars.toLocaleString()} chars${
                totalTokens ? ` · ~${totalTokens.toLocaleString()} tokens` : ""
              }${source === "derived" ? " · reconstructed from the message array" : ""}`
        }
      />
      <CardBody className="space-y-1.5">
        {sections.length === 0 ? (
          <p className="text-xs text-ink-faint">Nothing recorded.</p>
        ) : (
          sections.map((section) => (
            <Collapsible
              key={section.id}
              summary={section.title}
              meta={`${section.role} · ${(section.chars || section.text.length).toLocaleString()} chars`}
            >
              <p className="max-h-[32rem] overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-ink-muted">
                {section.text}
              </p>
            </Collapsible>
          ))
        )}
      </CardBody>
    </Card>
  );
}
