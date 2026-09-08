/**
 * The id map the seeding scripts keep outside the database.
 *
 * Convex documents have no id of their own, so a script that imports the golden
 * dump (`tests/golden/postgres-week1/*.json`) needs somewhere to remember which
 * Convex id each golden uuid — or each synthetic key it invents — turned into.
 * During the migration that lived in a `legacyId` column on every table; the
 * column is gone, and this file is what replaced it.
 *
 * One JSON file per deployment (plus an optional suffix, so a script that seeds
 * its own league keeps its own map):
 *
 *   .cache/seed-map.<deployment>.json            scripts/seed-convex.ts
 *   .cache/seed-map.<deployment>.<suffix>.json   scripts/e2e-week.ts, loadtest-seed.ts
 *
 * `.cache/` is gitignored, so the map is per-checkout: delete it only if you have
 * also wiped the deployment, otherwise a re-run will import everything twice.
 */
import fs from "node:fs";
import path from "node:path";

/** `table -> golden id -> Convex id`. */
export type IdMap = Record<string, Record<string, string>>;

/** The deployment the map belongs to, as a filename-safe string. */
export function deploymentSlug(): string {
  const deployment = process.env.CONVEX_DEPLOYMENT;
  if (deployment) return deployment.replace(/[^A-Za-z0-9._-]+/g, "-");
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (url) return new URL(url).hostname.split(".")[0];
  return "unknown";
}

export function seedMapFile(root: string, suffix?: string): string {
  const name = suffix
    ? `seed-map.${deploymentSlug()}.${suffix}.json`
    : `seed-map.${deploymentSlug()}.json`;
  return path.join(root, ".cache", name);
}

export function readIdMap(file: string): IdMap {
  if (!fs.existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as IdMap) : {};
  } catch {
    // A truncated map is a resumable state, not a fatal one: start over.
    return {};
  }
}

export function writeIdMap(file: string, map: IdMap): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(map, null, 2)}\n`);
}

/** `Map<string, string>` view of one table, for the scripts that keep live maps. */
export function tableMap(map: IdMap, table: string): Map<string, string> {
  return new Map(Object.entries(map[table] ?? {}));
}

/** Fold a live `Map` back into the on-disk shape. */
export function setTable(map: IdMap, table: string, entries: Map<string, string>): void {
  map[table] = Object.fromEntries(entries);
}
