import type { Metadata } from "next";

import {
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
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

      <section className="space-y-4">
        <div className="border-b border-border pb-3">
          <h2 className="eyebrow text-foreground">Price book</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Dollars per million tokens, newest effective price per catalogued model.
          </p>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead numeric>Input $/M</TableHead>
              <TableHead numeric>Output $/M</TableHead>
              <TableHead numeric>Cached $/M</TableHead>
              <TableHead>Reasoning</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {prices.map((price) => (
              <TableRow key={price.modelId}>
                <TableCell className="font-mono text-xs text-foreground">{price.modelId}</TableCell>
                <TableCell className="text-muted-foreground">{price.provider}</TableCell>
                <TableCell numeric className="font-mono text-xs">
                  {price.inputPerM.toFixed(2)}
                </TableCell>
                <TableCell numeric className="font-mono text-xs">
                  {price.outputPerM.toFixed(2)}
                </TableCell>
                <TableCell numeric className="font-mono text-xs">
                  {price.cachedInputPerM === null ? "—" : price.cachedInputPerM.toFixed(3)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {price.supportsReasoning ? "yes" : "no"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      <p className="text-sm text-ink-faint">
        Prices are seeded estimates and are marked &ldquo;verify before production&rdquo; in
        <code className="mx-1 font-mono text-xs text-muted-foreground">lib/models.ts</code>. Cost is
        computed from this table unless the gateway reports a figure directly.
      </p>
    </div>
  );
}
