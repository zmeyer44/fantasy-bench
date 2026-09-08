import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { SkillForm } from "@/components/config/skill-form";
import { readOrNull } from "@/components/league/convex-errors";
import { PageHeader } from "@/components/ui";
import { api } from "@/convex/_generated/api";
import { fetchAuthQuery } from "@/lib/convex/server";
import { requireViewer } from "@/lib/convex/require-viewer";

export const metadata: Metadata = { title: "Edit skill" };

export default async function EditSkillPage({ params }: PageProps<"/skills/[slug]/edit">) {
  const { slug } = await params;
  const viewer = await requireViewer(`/skills/${slug}/edit`);

  const skill = await readOrNull(() => fetchAuthQuery(api.skills.get, { slug }));
  if (!skill) notFound();
  if (skill.authorUserId !== viewer.userId) notFound();

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <PageHeader
        eyebrow={
          <Link href={`/skills/${skill.slug}`} className="hover:text-ink">
            {skill.name}
          </Link>
        }
        title="Edit skill"
        description="Skills are not versioned. Saving changes what every attached agent reads on its next run."
      />
      <SkillForm
        mode="edit"
        skillId={skill._id}
        usageCount={skill.usageCount}
        initial={{
          name: skill.name,
          description: skill.description ?? "",
          bodyMd: skill.bodyMd,
          visibility: skill.visibility,
        }}
      />
    </div>
  );
}
