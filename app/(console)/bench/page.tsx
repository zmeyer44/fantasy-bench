import type { Metadata } from "next";

import {
  Card,
  PageHeader,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from "@/components/ui";
import { api } from "@/convex/_generated/api";
import { fetchAuthQuery } from "@/lib/convex/server";

export const metadata: Metadata = { title: "Bench" };

/**
 * Placeholder for the cross-league benchmark (PRD 5.12, v1.1). Until runs exist
 * to aggregate, this shows the model catalog the leaderboards will be cut by.
 */
export default async function BenchPage() {
  // `ledger.modelPrices` already resolves the newest effective price per
  // catalogued model, so the page renders the rows as they come back.
  const prices = await fetchAuthQuery(api.ledger.modelPrices, {});

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Benchmark"
        title="The Bench"
        description="Cross-league leaderboards by model and by canonical config land once a season's runs exist. Until then: the pinned model catalog and its price book."
      />

      <Card>
        <Table>
          <THead>
            <TR>
              <TH>Model</TH>
              <TH>Provider</TH>
              <TH numeric>Input $/M</TH>
              <TH numeric>Output $/M</TH>
              <TH numeric>Cached $/M</TH>
              <TH>Reasoning</TH>
            </TR>
          </THead>
          <TBody>
            {prices.map((price) => (
              <TR key={price.modelId}>
                <TD className="font-mono text-xs">{price.modelId}</TD>
                <TD className="text-ink-muted">{price.provider}</TD>
                <TD numeric>{price.inputPerM.toFixed(2)}</TD>
                <TD numeric>{price.outputPerM.toFixed(2)}</TD>
                <TD numeric>
                  {price.cachedInputPerM === null ? "—" : price.cachedInputPerM.toFixed(3)}
                </TD>
                <TD className="text-ink-muted">{price.supportsReasoning ? "yes" : "no"}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>

      <p className="text-xs text-ink-faint">
        Prices are seeded estimates and are marked &ldquo;verify before production&rdquo; in
        <code className="mx-1 font-mono">lib/models.ts</code>. Cost is computed from this table
        unless the gateway reports a figure directly.
      </p>
    </div>
  );
}
