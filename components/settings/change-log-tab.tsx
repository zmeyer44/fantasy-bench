import { Card, CardHeader, EmptyState, TBody, TD, TH, THead, TR, Table } from "@/components/ui";
import { formatET } from "@/lib/time";

import type { SettingsData } from "./types";

/** The `league_rule_changes` audit trail — a server component; nothing here mutates. */
export function ChangeLogTab({ data }: { data: SettingsData }) {
  if (data.changes.length === 0) {
    return (
      <Card>
        <CardHeader title="Change log" />
        <div className="p-4">
          <EmptyState
            title="No changes yet"
            description="Every rule, budget, allowlist, owner and team change lands here."
          />
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Change log"
        description={`${data.changes.length} change${data.changes.length === 1 ? "" : "s"}, newest first`}
      />
      <Table>
        <THead>
          <TR>
            <TH>When</TH>
            <TH>Who</TH>
            <TH>Field</TH>
            <TH>From</TH>
            <TH>To</TH>
            <TH>Note</TH>
          </TR>
        </THead>
        <TBody>
          {data.changes.map((change) => (
            <TR key={change.id}>
              <TD className="whitespace-nowrap font-mono text-[10px] text-ink-muted">
                {formatET(change.createdAt, "MMM d HH:mm")} ET
              </TD>
              <TD className="text-xs text-ink">{change.userName ?? "platform"}</TD>
              <TD className="font-mono text-[10px] text-ink">{change.field}</TD>
              <TD className="max-w-48 truncate font-mono text-[10px] text-ink-faint">
                {render(change.fromValue)}
              </TD>
              <TD className="max-w-48 truncate font-mono text-[10px] text-ink">
                {render(change.toValue)}
              </TD>
              <TD className="text-xs text-ink-muted">{change.note ?? "—"}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </Card>
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
