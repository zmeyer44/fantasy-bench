import {
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";
import { formatET } from "@/lib/time";

import type { SettingsData } from "./types";

/** The `league_rule_changes` audit trail — a server component; nothing here mutates. */
export function ChangeLogTab({ data }: { data: SettingsData }) {
  return (
    <section className="space-y-5">
      <header className="border-b border-border pb-3">
        <h2 className="font-heading text-base leading-snug font-medium text-foreground">
          Change log
        </h2>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Every rule, budget, allowlist, owner and team change lands here
          {data.changes.length === 0
            ? "."
            : ` — ${data.changes.length} change${data.changes.length === 1 ? "" : "s"}, newest first.`}
        </p>
      </header>

      {data.changes.length === 0 ? (
        <EmptyState
          title="No changes yet"
          description="Nothing has been changed since the league was created."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Who</TableHead>
              <TableHead>Field</TableHead>
              <TableHead>From</TableHead>
              <TableHead>To</TableHead>
              <TableHead>Note</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.changes.map((change) => (
              <TableRow key={change._id}>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {formatET(change.createdAt ?? change._creationTime, "MMM d HH:mm")} ET
                </TableCell>
                <TableCell>{change.userName ?? "platform"}</TableCell>
                <TableCell className="font-mono text-xs text-foreground">{change.field}</TableCell>
                <TableCell className="max-w-48 truncate font-mono text-xs text-ink-faint">
                  {render(change.fromValue)}
                </TableCell>
                <TableCell className="max-w-48 truncate font-mono text-xs text-foreground">
                  {render(change.toValue)}
                </TableCell>
                <TableCell className="text-muted-foreground">{change.note ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

function render(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
