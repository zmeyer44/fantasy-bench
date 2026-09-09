"use client";

import { useMutation } from "convex/react";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { clearDraft, MarkdownEditor } from "@/components/editor/markdown-editor";
import {
  mutationErrorIssues,
  mutationErrorMessage,
  type ConvexIssue,
} from "@/components/league/convex-errors";
import {
  Button,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  Section,
  SectionHeader,
} from "@/components/ui";
import { api } from "@/convex/_generated/api";
import {
  MAX_SKILL_BODY_CHARS,
  MAX_SKILL_DESCRIPTION_CHARS,
  MAX_SKILL_NAME_CHARS,
  MIN_SKILL_NAME_CHARS,
} from "@/convex/lib/skills_pure";

import { skillStashKey, stashPublishedSkill } from "./skill-stash";

/**
 * Authoring a skill, on its own page rather than in a dialog: a skill is a
 * markdown document the model reads verbatim, so it gets the same editor the
 * agent context does — toolbar, split preview, fullscreen, draft recovery.
 *
 * Publishing writes to the shared library and hands the new skill back to the
 * editor through the draft stash, which attaches it. The config version itself
 * is still saved from the prompt tab.
 */
export function SkillComposer({
  leagueId,
  teamId,
  teamName,
  canEdit,
}: {
  leagueId: string;
  teamId: string;
  teamName: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const backHref = `/leagues/${leagueId}/teams/${teamId}/config?tab=prompt`;
  const draftKey = `skill:${leagueId}:${teamId}`;

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [bodyMd, setBodyMd] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<ConvexIssue[]>([]);

  const create = useMutation(api.skills.create);

  const named = name.trim().length >= MIN_SKILL_NAME_CHARS;
  const written = bodyMd.trim().length > 0;
  const overLimit = bodyMd.length > MAX_SKILL_BODY_CHARS;
  const ready = named && written && !overLimit;

  async function publish() {
    if (!ready) return;
    setPublishing(true);
    setError(null);
    setIssues([]);
    try {
      const skill = await create({
        name: name.trim(),
        description: description.trim(),
        bodyMd,
        visibility: "public",
      });
      clearDraft(draftKey);
      stashPublishedSkill(skillStashKey(leagueId, teamId), {
        id: skill._id,
        name: skill.name,
        slug: skill.slug,
        description: skill.description ?? "",
        bodyMd: skill.bodyMd,
      });
      router.replace(backHref);
    } catch (err) {
      setError(mutationErrorMessage(err));
      setIssues(mutationErrorIssues(err));
      setPublishing(false);
    }
  }

  if (!canEdit) {
    return (
      <p className="border-t border-border pt-5 text-sm text-muted-foreground">
        Only {teamName}&apos;s owner or the commissioner can author a skill for
        this agent. The library itself is public — read any skill from the{" "}
        <Link href={backHref} className="text-foreground underline-offset-4 hover:underline">
          prompt tab
        </Link>
        .
      </p>
    );
  }

  return (
    <div className="space-y-8">
      {/* ---------------------------------------------------------- identity */}
      <Section>
        <SectionHeader
          eyebrow="Identity"
          title="How the library lists it"
          description="The name becomes the skill's permanent slug; the description is what owners read before attaching."
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="new-skill-name">Name</FieldLabel>
            <Input
              id="new-skill-name"
              autoFocus
              value={name}
              maxLength={MAX_SKILL_NAME_CHARS}
              placeholder="Bye-week planner"
              onChange={(e) => setName(e.target.value)}
            />
            <FieldDescription>
              At least {MIN_SKILL_NAME_CHARS} characters.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="new-skill-description">
              One-line description
            </FieldLabel>
            <Input
              id="new-skill-description"
              value={description}
              maxLength={MAX_SKILL_DESCRIPTION_CHARS}
              placeholder="Plans two weeks ahead so no slot is left empty on a bye."
              onChange={(e) => setDescription(e.target.value)}
            />
            <FieldDescription className="text-right font-mono text-xs tabular-nums">
              {description.length}/{MAX_SKILL_DESCRIPTION_CHARS}
            </FieldDescription>
          </Field>
        </div>
      </Section>

      {/* -------------------------------------------------------------- body */}
      <Section>
        <SectionHeader
          eyebrow="Instructions"
          title="What the model reads"
          description="Markdown, injected after your context in the order the skill is attached."
        />
        <MarkdownEditor
          kind="skill"
          id="new-skill-body"
          aria-label="Skill markdown"
          value={bodyMd}
          onChange={setBodyMd}
          maxChars={MAX_SKILL_BODY_CHARS}
          draftKey={draftKey}
          minHeight={560}
          onSave={() => {
            if (!publishing) void publish();
          }}
          placeholder={
            "# Skill name\n\nOne sentence on what this makes the agent better at.\n\n## When to use it\n\n## Procedure\n\nUse Insert for a starting structure."
          }
        />
        <p className="mt-2.5 text-sm text-muted-foreground">
          Skills are public: every league can read and fork what you write.
          Owners attach them by id, so editing this skill later changes the
          prompt of every agent running it.
        </p>
      </Section>

      {/* ---------------------------------------------------------- save bar */}
      <div className="sticky bottom-4 z-20">
        <div className="rounded-lg border border-line-strong bg-card/95 shadow-lg backdrop-blur supports-backdrop-filter:bg-card/80">
          <div className="flex flex-wrap items-center justify-between gap-4 p-4">
            <span className="text-xs text-muted-foreground">
              {!named
                ? "Name it to publish."
                : !written
                  ? "Write the instructions to publish."
                  : overLimit
                    ? `Over the ${MAX_SKILL_BODY_CHARS.toLocaleString()}-character limit.`
                    : `Publishes to the library and attaches to ${teamName}'s draft.`}
            </span>
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                render={<Link href={backHref} />}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="lg"
                disabled={publishing || !ready}
                onClick={() => void publish()}
              >
                {publishing ? "Publishing…" : "Publish & attach"}
              </Button>
            </div>
          </div>
          {error ? (
            <div className="border-t border-border px-4 py-3">
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
              {issues.length > 0 ? (
                <ul className="mt-1.5 space-y-1">
                  {issues.map((issue) => (
                    <li
                      key={`${issue.field}:${issue.message}`}
                      className="text-sm text-destructive"
                    >
                      <span className="font-mono text-xs">{issue.field}</span> —{" "}
                      {issue.message}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="border-t border-border pt-5">
        <Link
          href={backHref}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          Back to the prompt
        </Link>
      </div>
    </div>
  );
}
