/**
 * Provider ingestion CLI.
 *
 *   npx tsx scripts/ingest.ts players
 *   npx tsx scripts/ingest.ts schedule     --season 2026
 *   npx tsx scripts/ingest.ts projections  --season 2026 --week 1
 *   npx tsx scripts/ingest.ts stats        --season 2025 --week 1
 *   npx tsx scripts/ingest.ts news         --season 2026 --week 1
 *   npx tsx scripts/ingest.ts ownership    --season 2026 --week 1
 *   npx tsx scripts/ingest.ts all          --season 2026 --week 1
 *
 * Flags: --season, --week, --force (bypass the player cache),
 *        --provider <source> (projection source; default: first configured).
 */
import { pgClient } from "@/lib/db";
import {
  PROJECTION_PROVIDERS,
  defaultProjectionProvider,
  projectionProviderBySource,
} from "@/lib/providers";
import {
  ingestInjuriesAndNews,
  ingestOwnership,
  ingestPlayers,
  ingestProjections,
  ingestSchedule,
  ingestStats,
} from "@/lib/providers/ingest";
import { fetchState } from "@/lib/providers/sleeper";

const COMMANDS = [
  "players",
  "schedule",
  "projections",
  "stats",
  "news",
  "ownership",
  "all",
] as const;
type Command = (typeof COMMANDS)[number];

function parseArgs(argv: string[]): {
  command: Command;
  season?: number;
  week?: number;
  force: boolean;
  provider?: string;
} {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command as Command)) {
    throw new Error(`Usage: tsx scripts/ingest.ts ${COMMANDS.join("|")} [--season N] [--week N]`);
  }
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith("--")) continue;
    const key = rest[i].slice(2);
    const value = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : "true";
    flags.set(key, value);
  }
  return {
    command: command as Command,
    season: flags.has("season") ? Number(flags.get("season")) : undefined,
    week: flags.has("week") ? Number(flags.get("week")) : undefined,
    force: flags.get("force") === "true",
    provider: flags.get("provider"),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Sleeper's state endpoint is the cheapest way to learn the live week.
  const state = args.season && args.week ? null : await fetchState();
  const season = args.season ?? state?.season ?? new Date().getUTCFullYear();
  const week = args.week ?? state?.week ?? 1;

  const provider = args.provider
    ? projectionProviderBySource(args.provider)
    : defaultProjectionProvider();
  if (args.provider && !provider) {
    throw new Error(
      `Unknown projection provider "${args.provider}". Known: ${PROJECTION_PROVIDERS.map((p) => p.source).join(", ")}`,
    );
  }

  const run = args.command;
  const all = run === "all";
  console.log(`Ingesting ${run} for season ${season}, week ${week}\n`);

  if (all || run === "players") {
    console.log("players:", await ingestPlayers({ force: args.force }));
  }
  if (all || run === "schedule") {
    console.log("schedule:", await ingestSchedule(season));
  }
  if (all || run === "projections") {
    console.log("projections:", await ingestProjections(season, week, { provider }));
  }
  if (all || run === "stats") {
    console.log("stats:", await ingestStats(season, week));
  }
  if (all || run === "news") {
    console.log("news+injuries:", await ingestInjuriesAndNews({ season, week }));
  }
  if (all || run === "ownership") {
    console.log("ownership:", await ingestOwnership(season, week));
  }
}

main()
  .then(async () => {
    await pgClient.end({ timeout: 5 });
  })
  .catch(async (err) => {
    console.error(err);
    await pgClient.end({ timeout: 5 }).catch(() => {});
    process.exit(1);
  });
