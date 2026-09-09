import { expect, test } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";
import { loadEnvConfig } from "@next/env";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { DEFAULT_LEAGUE_RULES } from "../../convex/lib/defaults";

const shots = "e2e/screenshots/reaudit-scoring-history";
loadEnvConfig(process.cwd());
const client = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
const secret = process.env.SEED_SECRET!;
const execFileAsync = promisify(execFile);
async function insert(table: string, rows: Record<string, unknown>[]) {
  return (await client.mutation(api.seed.importBatch, { secret, table, rows })).ids;
}

// Backend-assisted isolated fixtures: existing QA owner and real NFL player records
// are read only. No demo league, current-season stats, or auth rows are changed.
async function fixture(label: string) {
  await mkdir(shots, { recursive: true });
  const qa = JSON.parse(readFileSync(".cache/audit-community-fixture.json", "utf8"));
  const source = await client.query(api.leagues.get, { leagueId: qa.leagueId });
  const now = Date.now();
  const [rawLeagueId] = await insert("leagues", [{
    name: `QA Reaudit ${label} ${now}`, slug: `qa-reaud-${label}-${now}`,
    commissionerUserId: source.league.commissionerUserId, season: 2097,
    teamCount: 8, isPublic: true, status: "in_season", draftType: "snake", updatedAt: now,
  }]);
  const leagueId = rawLeagueId as Id<"leagues">;
  await insert("league_rules", [{ leagueId, ...DEFAULT_LEAGUE_RULES, modelAllowlist: ["mock/scripted"] }]);
  const teamIds = await insert("teams", Array.from({ length: 8 }, (_, i) => ({
    leagueId, name: `Audit Team ${i + 1}`, abbreviation: `AT${i + 1}`,
    faabRemaining: 100, waiverPriority: i + 1, karma: 0, draftBudgetRemaining: 200,
  })));
  await insert("weeks", [{ leagueId, weekNo: 1, startsAt: now - 3600000,
    endsAt: now + 86400000, isPlayoff: false, status: "active" }]);
  return { leagueId, teamIds, now, base: `/leagues/${leagueId}` };
}

// Journey 1: open a live matchup → real scoring mutation receives newer stats →
// compare list/detail against the persisted score → reload and verify freshness.
test("live scoring follows fresh stats after a frozen agent snapshot", async ({ page }) => {
  test.setTimeout(120000);
  const f = await fixture("scoring");
  const demoId = "m577b26pyjz8m5w86fxbpkdf418e1mah" as Id<"leagues">;
  const demoCards = await client.query(api.views.matchups, { leagueId: demoId, weekNo: 1 });
  const demo = await client.query(api.views.matchup, { leagueId: demoId, weekNo: 1, matchupId: demoCards[0].id as Id<"matchups"> });
  const player = demo!.home.slots.find((slot) => slot.playerId)!;
  await insert("lineups", [{ leagueId: f.leagueId, teamId: f.teamIds[0], weekNo: 1,
    version: 1, source: "agent", slots: [{ slot: player.position!, playerId: player.playerId }] }]);
  await insert("roster_slots", [{ leagueId: f.leagueId, teamId: f.teamIds[0], playerId: player.playerId,
    acquiredAt: f.now, acquiredVia: "draft" }]);
  const [rawMatchupId] = await insert("matchups", [{ leagueId: f.leagueId, weekNo: 1,
    homeTeamId: f.teamIds[0], awayTeamId: f.teamIds[1], homeScore: 12, awayScore: 0, isFinal: false }]);
  const matchupId = rawMatchupId as Id<"matchups">;
  const [snapshotId] = await insert("snapshots", [{ leagueId: f.leagueId, season: 2097, weekNo: 1,
    takenAt: f.now - 60000, status: "ready", chunkCount: 1, playerCount: 1 }]);
  await insert("snapshot_chunks", [{ snapshotId, kind: "meta", part: 0, bytes: 100,
    data: { liveScores: { [player.playerId!]: 12 } } }]);
  await insert("player_stats_weekly", [{ playerId: player.playerId, season: 2097, week: 1,
    source: "sleeper", stats: {}, fantasyPointsPpr: 12, fantasyPointsHalf: 12,
    fantasyPointsStd: 12, effectiveAt: f.now - 60000 }]);
  await page.goto(`${f.base}/matchups/1/${matchupId}`);
  await expect(page.getByRole("region", { name: "Matchup scoreboard" })).toContainText("12.00");
  await page.screenshot({ path: `${shots}/01-before-score-update.png`, fullPage: true });
  await insert("player_stats_weekly", [{ playerId: player.playerId, season: 2097, week: 1,
    source: "sleeper", stats: {}, fantasyPointsPpr: 20, fantasyPointsHalf: 20,
    fantasyPointsStd: 20, effectiveAt: f.now }]);
  await insert("nfl_games", [{ season: 2097, week: 1, gameId: `reaud-${f.now}`,
    homeTeam: player.nflTeam ?? "KC", awayTeam: "BUF", kickoffAt: f.now - 3600000, status: "in_progress" }]);
  await execFileAsync("npx", ["convex", "run", "scoring:scoreLeague", JSON.stringify({ leagueId: f.leagueId, weekNo: 1 })],
    { cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 });
  const detail = await client.query(api.views.matchup, { leagueId: f.leagueId, weekNo: 1, matchupId });
  const cards = await client.query(api.views.matchups, { leagueId: f.leagueId, weekNo: 1 });
  expect(detail!.home.officialScore).toBe(20);
  await page.reload();
  await expect(page.getByRole("region", { name: "Matchup scoreboard" })).toBeVisible();
  await page.screenshot({ path: `${shots}/02-after-score-update.png`, fullPage: true });
  const scoreboardText = await page.getByRole("region", { name: "Matchup scoreboard" }).innerText();
  await page.goto(`${f.base}/matchups/1`);
  await expect(page.getByRole("link", { name: /Audit Team 1/ }).last()).toBeVisible();
  await page.screenshot({ path: `${shots}/03-stale-matchup-card.png`, fullPage: true });
  await writeFile(`${shots}/scoring-observations.json`, JSON.stringify({ leagueId: f.leagueId, matchupId,
    official: detail!.home.officialScore, snapshotTotal: detail!.home.liveTotal,
    card: cards[0].home.score, scoreboardText }, null, 2));
  expect.soft(cards[0].home.score, "Card must show the current scorer result").toBe(20);
  expect.soft(scoreboardText, "Detail must show the current scorer result").toContain("20.00");
});

// Journey 2: load all 100 real feed rows → observe 45 real new backend events →
// verify no intermediate arrivals disappear and compare with reloaded pagination.
test("loaded activity history retains arrivals after the live head rolls over", async ({ page }) => {
  test.setTimeout(120000);
  const f = await fixture("history");
  const rows = (start: number, count: number) => Array.from({ length: count }, (_, n) => ({
    leagueId: f.leagueId, title: `Audit event ${start + n}`, body: "Isolated activity retention fixture.",
    flair: "analysis", score: 0, commentCount: 0, hidden: false, createdAt: f.now + start + n,
  }));
  await insert("forum_posts", rows(0, 100));
  await page.goto(f.base);
  const feed = page.getByRole("region", { name: "League activity" });
  const items = feed.getByRole("listitem");
  const more = feed.getByRole("button", { name: "Show more", exact: true });
  await expect(items).toHaveCount(40);
  await more.click();
  await expect(items).toHaveCount(80);
  await more.click();
  await expect(items).toHaveCount(100);
  await expect(more).toHaveCount(0);
  await feed.getByRole("link", { name: "Audit event 99", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/04-history-100-loaded.png` });
  await insert("forum_posts", rows(100, 5));
  await expect(items).toHaveCount(105);
  await expect(feed.getByRole("link", { name: "Audit event 100", exact: true })).toBeVisible();
  await feed.getByRole("link", { name: "Audit event 100", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/05-five-new-arrivals.png` });
  await insert("forum_posts", rows(105, 40));
  await expect(feed.getByRole("link", { name: "Audit event 144", exact: true })).toBeVisible();
  // The history visibility subscriptions revalidate on head changes. Wait for
  // the original 100 rows before measuring permanent loss of the five arrivals.
  await expect.poll(() => items.count()).toBeGreaterThanOrEqual(140);
  const afterArrivalCount = await items.count();
  const missing = await feed.getByRole("link", { name: "Audit event 100", exact: true }).count();
  const canLoadMore = await more.count();
  await feed.getByRole("link", { name: "Audit event 105", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/06-after-head-rollover.png` });
  await page.reload();
  await expect(items).toHaveCount(40);
  for (const count of [80, 120, 145]) {
    await more.click();
    await expect(items).toHaveCount(count);
  }
  await expect(more).toHaveCount(0);
  await expect(feed.getByRole("link", { name: "Audit event 100", exact: true })).toBeVisible();
  await feed.getByRole("link", { name: "Audit event 100", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/07-reloaded-history-restored.png` });
  await writeFile(`${shots}/history-observations.json`, JSON.stringify({ leagueId: f.leagueId,
    afterArrivalCount, event100Visible: missing > 0, canLoadMore: canLoadMore > 0, afterReloadCount: await items.count() }, null, 2));
  expect.soft(afterArrivalCount, "All 145 rows must remain visible without reload").toBe(145);
  expect.soft(missing, "An event already seen must not disappear as new activity arrives").toBe(1);
});

// Journey 3 (read only): browse the real wire → search and filter → clear an
// empty result → inspect an injured player at narrow mobile width → view claims.
test("player scouting filters and mobile injury information", async ({ page }) => {
  await mkdir(shots, { recursive: true });
  const leagueId = "m577b26pyjz8m5w86fxbpkdf418e1mah" as Id<"leagues">;
  const pool = await client.query(api.waivers.available, { leagueId });
  const player = pool.players.find((row) => row.injuryStatus && row.fullName.length > 12)!;
  expect(player).toBeTruthy();
  await page.goto(`/leagues/${leagueId}/waivers`);
  const table = page.getByRole("table", { name: "Available players", exact: true });
  await expect(table.getByRole("row")).toHaveCount(31);
  await page.getByRole("button", { name: /Show more players/ }).click();
  await expect(table.getByRole("row")).toHaveCount(61);
  await page.getByLabel("Search players", { exact: true }).fill(`  ${player.fullName.toUpperCase()}  `);
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table).toContainText(player.fullName);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${shots}/08-player-desktop-injury.png` });
  await page.getByLabel("Search players", { exact: true }).fill("no-player-reaudit-match");
  await expect(page.getByRole("heading", { name: "No matching players" })).toBeVisible();
  await page.getByLabel("Search players", { exact: true }).fill("");
  await page.getByRole("group", { name: "Filter by position" }).getByRole("button", { name: player.position === "DEF" ? "D/ST" : player.position, exact: true }).click();
  await page.getByLabel("Sort by", { exact: true }).selectOption("name");
  const names = await table.getByRole("row").allTextContents();
  expect(names.length).toBeGreaterThan(1);
  expect(names.slice(1).every((name) => name.includes(player.position))).toBe(true);
  await page.screenshot({ path: `${shots}/09-player-position-filter.png` });
  await page.getByRole("group", { name: "Filter by position" }).getByRole("button", { name: "All", exact: true }).click();
  await page.getByLabel("Search players", { exact: true }).fill(player.fullName);
  await page.setViewportSize({ width: 320, height: 844 });
  await expect(page.getByRole("navigation", { name: "League sections" }).last().locator('[aria-current="page"]')).toBeInViewport();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${shots}/10-player-mobile-injury.png`, fullPage: true });
  const injury = table.getByText(player.injuryStatus!, { exact: true });
  const clipping = await injury.evaluate((node) => {
    const parent = node.parentElement!;
    const bounds = parent.getBoundingClientRect();
    const text = node.getBoundingClientRect();
    return { injuryText: node.textContent, injuryLeft: text.left, injuryRight: text.right,
      visibleRight: bounds.right, parentOverflow: getComputedStyle(parent).overflow,
      clipped: text.right > bounds.right, title: parent.getAttribute("title") };
  });
  await page.getByRole("button", { name: "Claim activity", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Week 1 claims", exact: true })).toBeVisible();
  await page.screenshot({ path: `${shots}/11-mobile-claim-results.png`, fullPage: true });
  await writeFile(`${shots}/scouting-observations.json`, JSON.stringify({ player: player.fullName, clipping }, null, 2));
  expect(clipping.clipped, "Injury status must be readable in the only player information surface").toBe(false);
});
