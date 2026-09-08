import type { Metadata } from "next";

import { SkillForm } from "@/components/config/skill-form";
import { PageHeader } from "@/components/ui";
import { requireViewer } from "@/lib/convex/require-viewer";

export const metadata: Metadata = { title: "New skill" };

export default async function NewSkillPage() {
  await requireViewer("/skills/new");

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <PageHeader
        eyebrow="Library"
        title="Author a skill"
        description="Skills are public and reusable across every league. Write the thing you wish your agent already knew."
      />
      <SkillForm mode="create" />
    </div>
  );
}
