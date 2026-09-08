import Link from "next/link";

import { Badge, Card, CardBody, CardHeader, cn } from "@/components/ui";
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
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Model & harness"
          description={
            changedFields.length === 0
              ? "No settings changed between these versions."
              : `${changedFields.length} setting${changedFields.length === 1 ? "" : "s"} changed.`
          }
        />
        <CardBody className="p-0">
          <table className="w-full border-collapse text-sm">
            <thead className="border-b border-line">
              <tr>
                <th className="eyebrow px-4 py-2 text-left">Setting</th>
                <th className="eyebrow px-4 py-2 text-left">
                  v{diff.a.versionNo}
                </th>
                <th className="eyebrow px-4 py-2 text-left">
                  v{diff.b.versionNo}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {fieldRows.map((f) => (
                <tr key={f.field} className={f.changed ? "bg-accent-soft/40" : undefined}>
                  <td className="px-4 py-2 text-ink-muted">{f.label}</td>
                  <td
                    className={cn(
                      "px-4 py-2 font-mono text-xs tabular-nums",
                      f.changed && "text-danger line-through decoration-danger/50",
                    )}
                  >
                    {f.from ?? "—"}
                  </td>
                  <td
                    className={cn(
                      "px-4 py-2 font-mono text-xs tabular-nums",
                      f.changed ? "font-semibold text-accent-strong" : "text-ink",
                    )}
                  >
                    {f.to ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Skills"
          description={
            diff.skills.changed
              ? diff.skills.reordered && diff.skills.added.length === 0 && diff.skills.removed.length === 0
                ? "Same skills, different injection order."
                : "Attached skills changed."
              : "No change."
          }
        />
        <CardBody className="space-y-3">
          {diff.skills.after.length === 0 && diff.skills.before.length === 0 ? (
            <p className="text-sm text-ink-muted">No skills attached to either version.</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
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
        </CardBody>
      </Card>

      <Card>
        <CardHeader
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
                className="text-xs text-accent-strong underline underline-offset-2"
              >
                Open editor
              </Link>
            ) : null
          }
        />
        <CardBody className="p-0">
          {diff.context.changed ? (
            <div className="overflow-x-auto">
              {diff.context.hunks.map((hunk, i) => (
                <Hunk key={i} hunk={hunk} />
              ))}
            </div>
          ) : (
            <p className="px-4 py-6 text-sm text-ink-muted">
              The context is byte-identical between these two versions.
            </p>
          )}
        </CardBody>
      </Card>
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
      <div className="eyebrow mb-2">{title}</div>
      {skills.length === 0 ? (
        <p className="text-sm text-ink-faint">none</p>
      ) : (
        <ol className="space-y-1">
          {skills.map((s, i) => (
            <li
              key={s.id}
              className={cn(
                "flex items-center gap-2 rounded border px-2 py-1 text-sm",
                highlight.has(s.id)
                  ? tone === "accent"
                    ? "border-accent/40 bg-accent-soft text-accent-strong"
                    : "border-danger/40 bg-danger/10 text-danger"
                  : "border-line bg-surface-muted/50 text-ink",
              )}
            >
              <span className="font-mono text-[10px] text-ink-faint">{i + 1}</span>
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
    <div className="border-b border-line last:border-b-0">
      <div className="bg-surface-muted px-4 py-1 font-mono text-[10px] text-ink-faint">
        {hunk.header}
      </div>
      <table className="w-full border-collapse font-mono text-[11px] leading-5">
        <tbody>
          {hunk.lines.map((line, i) => (
            <tr
              key={i}
              className={cn(
                line.kind === "add" && "bg-accent-soft",
                line.kind === "del" && "bg-danger/10",
              )}
            >
              <td className="w-10 select-none px-2 text-right text-ink-faint">{line.oldNo ?? ""}</td>
              <td className="w-10 select-none px-2 text-right text-ink-faint">{line.newNo ?? ""}</td>
              <td
                className={cn(
                  "w-4 select-none text-center",
                  line.kind === "add" && "text-accent-strong",
                  line.kind === "del" && "text-danger",
                )}
              >
                {line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}
              </td>
              <td
                className={cn(
                  "whitespace-pre-wrap break-words px-2 py-0.5",
                  line.kind === "add" && "text-accent-strong",
                  line.kind === "del" && "text-danger",
                  line.kind === "context" && "text-ink-muted",
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
  if (diff.context.changed) bits.push(`context +${diff.context.added}/−${diff.context.removed}`);
  if (diff.model.changed) bits.push("model");
  const harness = diff.harness.filter((h) => h.changed).length;
  if (harness > 0) bits.push(`${harness} harness`);
  if (diff.skills.changed) bits.push("skills");

  if (bits.length === 0) return <Badge tone="outline">no change</Badge>;
  return (
    <div className="flex flex-wrap gap-1">
      {bits.map((b) => (
        <Badge key={b} tone="accent">
          {b}
        </Badge>
      ))}
    </div>
  );
}
