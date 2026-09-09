import Link from "next/link";
import type { ReactNode } from "react";

import {
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from "@/components/ui";
import type { ConfigDiff, DiffHunk } from "@/convex/lib/config_pure";

/**
 * Renders a `ConfigDiff`: the context as a unified diff with a two-column
 * gutter, and model / harness / skills as field tables.
 */
export function DiffView({
  diff,
  leagueId,
  teamId,
}: {
  diff: ConfigDiff;
  leagueId?: string;
  teamId?: string;
}) {
  const fieldRows = [diff.model, ...diff.harness];
  const changedFields = fieldRows.filter((f) => f.changed);

  return (
    <div className="space-y-10">
      <section className="space-y-4">
        <SectionHeading
          title="Model & harness"
          description={
            changedFields.length === 0
              ? "No settings changed between these versions."
              : `${changedFields.length} setting${changedFields.length === 1 ? "" : "s"} changed.`
          }
        />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Setting</TableHead>
              <TableHead>v{diff.a.versionNo}</TableHead>
              <TableHead>v{diff.b.versionNo}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {fieldRows.map((f) => (
              <TableRow key={f.field}>
                <TableCell className="text-muted-foreground">
                  {f.label}
                </TableCell>
                <TableCell
                  className={cn(
                    "font-mono text-xs",
                    f.changed
                      ? "text-destructive line-through decoration-destructive/50"
                      : "text-muted-foreground",
                  )}
                >
                  {f.from ?? "—"}
                </TableCell>
                <TableCell
                  className={cn(
                    "font-mono text-xs",
                    f.changed ? "font-semibold text-brand" : "text-foreground",
                  )}
                >
                  {f.to ?? "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      <section className="space-y-4">
        <SectionHeading
          title="Skills"
          description={
            diff.skills.changed
              ? diff.skills.reordered &&
                diff.skills.added.length === 0 &&
                diff.skills.removed.length === 0
                ? "Same skills, different injection order."
                : "Attached skills changed."
              : "No change."
          }
        />
        {diff.skills.after.length === 0 && diff.skills.before.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No skills attached to either version.
          </p>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2">
            <SkillColumn
              title={`v${diff.a.versionNo}`}
              skills={diff.skills.before}
              highlight={new Set(diff.skills.removed.map((s) => s.id))}
              tone="danger"
            />
            <SkillColumn
              title={`v${diff.b.versionNo}`}
              skills={diff.skills.after}
              highlight={new Set(diff.skills.added.map((s) => s.id))}
              tone="accent"
            />
          </div>
        )}
      </section>

      <section className="space-y-4">
        <SectionHeading
          title="Context"
          description={
            diff.context.changed
              ? `+${diff.context.added} / −${diff.context.removed} lines`
              : "Identical."
          }
          action={
            leagueId && teamId ? (
              <Link
                href={`/leagues/${leagueId}/teams/${teamId}/config`}
                className="text-sm text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-foreground hover:decoration-brand"
              >
                Open editor
              </Link>
            ) : null
          }
        />
        {diff.context.changed ? (
          <div className="overflow-x-auto rounded-lg border border-border">
            {diff.context.hunks.map((hunk, i) => (
              <Hunk key={i} hunk={hunk} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            The context is byte-identical between these two versions.
          </p>
        )}
      </section>
    </div>
  );
}

function SectionHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-3">
      <div className="min-w-0">
        <h2 className="eyebrow text-foreground">{title}</h2>
        {description ? (
          <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

function SkillColumn({
  title,
  skills,
  highlight,
  tone,
}: {
  title: string;
  skills: Array<{ id: string; name: string; slug: string }>;
  highlight: Set<string>;
  tone: "accent" | "danger";
}) {
  return (
    <div>
      <div className="eyebrow mb-2.5">{title}</div>
      {skills.length === 0 ? (
        <p className="text-sm text-ink-faint">none</p>
      ) : (
        <ol className="space-y-1">
          {skills.map((s, i) => (
            <li
              key={s.id}
              className={cn(
                "flex items-center gap-2.5 rounded-sm border px-2.5 py-1.5 text-sm",
                highlight.has(s.id)
                  ? tone === "accent"
                    ? "border-brand/30 bg-brand-soft text-brand"
                    : "border-destructive/40 bg-destructive/10 text-destructive"
                  : "border-border text-foreground",
              )}
            >
              <span className="font-mono text-[10px] text-ink-faint tabular-nums">
                {i + 1}
              </span>
              <span className="truncate">{s.name}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Hunk({ hunk }: { hunk: DiffHunk }) {
  return (
    <div className="border-b border-border last:border-b-0">
      <div className="border-b border-border bg-muted px-3 py-1.5 font-mono text-[10px] tracking-wider text-ink-faint">
        {hunk.header}
      </div>
      <table className="w-full border-collapse font-mono text-xs leading-5 tabular-nums">
        <tbody>
          {hunk.lines.map((line, i) => (
            <tr
              key={i}
              className={cn(
                line.kind === "add" && "bg-brand-soft",
                line.kind === "del" && "bg-destructive/10",
              )}
            >
              <td className="w-10 px-2 text-right text-ink-faint select-none">
                {line.oldNo ?? ""}
              </td>
              <td className="w-10 px-2 text-right text-ink-faint select-none">
                {line.newNo ?? ""}
              </td>
              <td
                className={cn(
                  "w-4 text-center select-none",
                  line.kind === "add" && "text-brand",
                  line.kind === "del" && "text-destructive",
                )}
              >
                {line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}
              </td>
              <td
                className={cn(
                  "px-2 py-0.5 break-words whitespace-pre-wrap",
                  line.kind === "add" && "text-brand",
                  line.kind === "del" && "text-destructive",
                  line.kind === "context" && "text-muted-foreground",
                )}
              >
                {line.text || " "}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Compact "what changed" line used in the version list. */
export function DiffSummaryBadges({ diff }: { diff: ConfigDiff }) {
  const bits: string[] = [];
  if (diff.context.changed)
    bits.push(`context +${diff.context.added}/−${diff.context.removed}`);
  if (diff.model.changed) bits.push("model");
  const harness = diff.harness.filter((h) => h.changed).length;
  if (harness > 0) bits.push(`${harness} harness`);
  if (diff.skills.changed) bits.push("skills");

  if (bits.length === 0) return <Badge variant="outline">No change</Badge>;
  return (
    <div className="flex flex-wrap gap-1">
      {bits.map((b) => (
        <Badge key={b} variant="secondary">
          {b}
        </Badge>
      ))}
    </div>
  );
}
