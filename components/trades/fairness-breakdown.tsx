import { TBody, TD, TH, THead, TR, Table } from "@/components/ui";
import type { FairnessDetailV1 } from "@/lib/services/trades/fairness";

/**
 * The published fairness working. Everything here is deterministic; the
 * `narrative`, when present, is the Commissioner Agent's prose and is clearly
 * labelled as commentary rather than input.
 */
export function FairnessBreakdown({
  detail,
  proposerTeamName,
  recipientTeamName,
  teamNameById,
}: {
  detail: FairnessDetailV1;
  proposerTeamName: string;
  recipientTeamName: string;
  teamNameById: Record<string, string>;
}) {
  const items = detail.items ?? [];
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={`${proposerTeamName} receives`} value={fmt(detail.proposerValue)} />
        <Stat label={`${recipientTeamName} receives`} value={fmt(detail.recipientValue)} />
        <Stat label="Fairness" value={detail.score?.toFixed(2) ?? "—"} />
        <Stat label="Floor" value={detail.floor?.toFixed(2) ?? "—"} />
      </dl>

      {items.length > 0 ? (
        <Table>
          <THead>
            <TR>
              <TH>Player</TH>
              <TH>Pos</TH>
              <TH>Goes to</TH>
              <TH numeric>ROS proj</TH>
              <TH numeric>Scarcity</TH>
              <TH numeric>Roster fit</TH>
              <TH numeric>Value</TH>
            </TR>
          </THead>
          <TBody>
            {items.map((item) => (
              <TR key={`${item.playerId}-${item.toTeamId}`}>
                <TD className="font-medium">{item.playerName}</TD>
                <TD className="font-mono text-xs text-ink-muted">{item.position}</TD>
                <TD className="text-ink-muted">
                  {teamNameById[item.toTeamId] ?? "—"}
                </TD>
                <TD numeric>{fmt(item.baseRos)}</TD>
                <TD numeric>×{item.scarcity.toFixed(2)}</TD>
                <TD numeric>{item.rosterFit > 1 ? `×${item.rosterFit.toFixed(2)}` : "—"}</TD>
                <TD numeric className="font-medium">
                  {fmt(item.value)}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : null}

      {detail.faab ? (
        <p className="text-xs text-ink-muted">
          FAAB: ${Math.abs(detail.faab)} moves{" "}
          {detail.faab > 0
            ? `${proposerTeamName} → ${recipientTeamName}`
            : `${recipientTeamName} → ${proposerTeamName}`}
          , valued at {fmt(detail.faabPoints)} projected points.
        </p>
      ) : null}

      {detail.notes?.length ? (
        <ul className="space-y-1 text-xs text-ink-faint">
          {detail.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}

      {detail.narrative ? (
        <div className="rounded-md border border-line bg-surface-muted px-3 py-2.5">
          <p className="eyebrow mb-1.5">Commissioner&apos;s note</p>
          <p className="text-sm text-ink">{detail.narrative}</p>
          <p className="mt-2 text-[11px] text-ink-faint">
            Commentary only — the score above is computed deterministically.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line bg-surface-muted px-3 py-2">
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-1 font-mono text-sm tabular-nums text-ink">{value}</dd>
    </div>
  );
}

function fmt(value: number | undefined): string {
  return value === undefined ? "—" : value.toFixed(1);
}
