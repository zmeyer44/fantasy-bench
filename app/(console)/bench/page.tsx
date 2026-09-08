import type { Metadata } from "next";
import { desc } from "drizzle-orm";

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
import { db } from "@/lib/db";
import { modelPrices } from "@/lib/db/schema";

export const metadata: Metadata = { title: "Bench" };

/**
 * Placeholder for the cross-league benchmark (PRD 5.12, v1.1). Until runs exist
 * to aggregate, this shows the model catalog the leaderboards will be cut by.
 */
export default async function BenchPage() {
  const prices = await db
    .select()
    .from(modelPrices)
    .orderBy(desc(modelPrices.effectiveFrom));

  const latest = new Map<string, (typeof prices)[number]>();
  for (const row of prices) if (!latest.has(row.modelId)) latest.set(row.modelId, row);

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
            {[...latest.values()].map((price) => (
              <TR key={price.id}>
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
