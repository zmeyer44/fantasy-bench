import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

import { expect, test, type Page } from "@playwright/test";

const execFileAsync = promisify(execFile);
const screenshots = "e2e/screenshots/reaudit-transactions/full-snake";
const fixture = JSON.parse(readFileSync(".cache/reaud-drafts-full-fixture.json", "utf8")) as {
  email: string;
  password: string;
  leagueId: string;
};
type WindowView = { id: string; label: string; status: string; runCount: number; terminalRunCount: number };
type Board = { teams: Array<{ id: string; name: string }>; picks: Array<{ auto: boolean; runId: string | null }> };
type TeamView = {
  roster: Array<{ playerId: string }>;
  lineup: Array<{ starting: boolean; entry: { playerId: string } | null }>;
  recentRuns: Array<{ outcome: string | null }>;
};

function parse(stdout: string): unknown {
  const starts = [stdout.indexOf("{"), stdout.indexOf("[")].filter((value) => value >= 0);
  const first = Math.min(...starts);
  const last = Math.max(stdout.lastIndexOf("}"), stdout.lastIndexOf("]"));
  if (!Number.isFinite(first) || last < first) throw new Error(`No JSON in: ${stdout}`);
  return JSON.parse(stdout.slice(first, last + 1));
}

async function convexRun<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { stdout } = await execFileAsync("npx", ["convex", "run", fn, JSON.stringify(args)], {
    cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024,
  });
  return parse(stdout) as T;
}

async function waitForRuns(windowId: string) {
  await expect.poll(async () => {
    const windows = await convexRun<WindowView[]>("windows:forWeek", { leagueId: fixture.leagueId, weekNo: 1 });
    const window = windows.find((row) => row.id === windowId);
    return window ? `${window.terminalRunCount}/${window.runCount}` : "missing";
  }, { timeout: 90_000, intervals: [500, 1_000, 2_000, 3_000] }).toMatch(/^([1-9]\d*)\/\1$/);
}

async function open(label: string) {
  const opened = await convexRun<{ windowId: string }>("windows:openNow", {
    leagueId: fixture.leagueId, label, weekNo: 1, roundNo: 1,
  });
  await waitForRuns(opened.windowId);
  return opened.windowId;
}

async function shot(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${screenshots}/${name}.png`, fullPage: true });
}

test("resume full draft through waivers, lineup, and scripted trade limits", async ({ page }) => {
  test.setTimeout(12 * 60_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/login");
  await page.getByLabel("Email").fill(fixture.email);
  await page.getByLabel("Password").fill(fixture.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/leagues$/, { timeout: 30_000 });

  // The completed board visibly discloses the late fallback picks found by the first journey.
  await page.goto(`/leagues/${fixture.leagueId}/draft`);
  await expect(page.getByText("120 / 120", { exact: true })).toBeVisible();
  const showAll = page.getByRole("button", { name: /Show all 120 picks/i });
  if (await showAll.isVisible()) await showAll.click();
  await expect(page.getByText(/auto-pick/i).first()).toBeVisible();
  await shot(page, "04-full-draft-with-late-autopicks");
  const board = await convexRun<Board>("draft:board", { leagueId: fixture.leagueId });
  expect(board.picks.filter((pick) => pick.auto)).toHaveLength(15);
  expect(board.picks.filter((pick) => pick.runId)).toHaveLength(105);

  // All fallback picks still finalize legal full rosters before transactions begin.
  for (const team of board.teams) {
    const view = await convexRun<TeamView>("views:team", { teamId: team.id });
    expect(view.roster, `${team.name} roster`).toHaveLength(15);
    expect(view.lineup.filter((slot) => slot.starting), `${team.name} starters`).toHaveLength(9);
    expect(view.lineup.filter((slot) => slot.starting).every((slot) => slot.entry)).toBe(true);
  }
  const teamId = board.teams[0]!.id;
  await page.goto(`/leagues/${fixture.leagueId}/teams/${teamId}`);
  await expect(page.getByText("Empty slot", { exact: true })).toHaveCount(0);
  await shot(page, "05-full-roster-complete-starters");

  // Process the terminal waiver runs and inspect actual conflict outcomes in the UI.
  const windows = await convexRun<WindowView[]>("windows:forWeek", { leagueId: fixture.leagueId, weekNo: 1 });
  const waiver = windows.find((window) => window.label === "waiver" && window.status === "open");
  await page.goto(`/leagues/${fixture.leagueId}/waivers?week=1`);
  await page.getByRole("button", { name: "Claim activity" }).click();
  if (waiver) {
    await expect(page.getByText("pending", { exact: true }).first()).toBeVisible();
    await shot(page, "06-default-roster-waivers-pending");
    await convexRun("windows:closeNow", { windowId: waiver.id });
  }
  await expect(page.getByText("won", { exact: true }).first()).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText("lost", { exact: true }).first()).toBeVisible();
  await shot(page, "07-default-roster-waiver-results");

  // The next lineup window must keep every required slot filled after add/drop processing.
  const refreshedWindows = await convexRun<WindowView[]>("windows:forWeek", { leagueId: fixture.leagueId, weekNo: 1 });
  const completedLineup = refreshedWindows.find((window) => window.label === "lineup_sun_early" && window.status === "closed");
  if (!completedLineup) {
    const lineupId = await open("lineup_sun_early");
    await convexRun("windows:closeNow", { windowId: lineupId });
  }
  for (const team of board.teams) {
    const view = await convexRun<TeamView>("views:team", { teamId: team.id });
    expect(view.roster.length).toBeLessThanOrEqual(15);
    expect(view.lineup.filter((slot) => slot.starting)).toHaveLength(9);
    expect(view.lineup.filter((slot) => slot.starting).every((slot) => slot.entry)).toBe(true);
    expect(view.recentRuns.some((run) => run.outcome === "lineup_incomplete")).toBe(false);
  }
  await page.goto(`/leagues/${fixture.leagueId}/teams/${teamId}`);
  await expect(page.getByText("Empty slot", { exact: true })).toHaveCount(0);
  await shot(page, "08-post-waiver-full-lineup");

  // Scripted trade agents expose proposals and rejections; they intentionally do not accept offers.
  const currentWindows = await convexRun<WindowView[]>("windows:forWeek", { leagueId: fixture.leagueId, weekNo: 1 });
  const existingTrade = currentWindows.find((window) => window.label === "trade_a" && window.status === "open");
  const tradeId = existingTrade?.id ?? await open("trade_a");
  await page.goto(`/leagues/${fixture.leagueId}/trades`);
  await expect(page.getByRole("link", { name: "Details →" }).first()).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText("Rejected", { exact: true }).first()).toBeVisible();
  await shot(page, "09-scripted-trade-proposals-and-rejections");
  await page.getByRole("link", { name: "Details →" }).first().click();
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
  await shot(page, "10-scripted-trade-detail");
  await convexRun("windows:closeNow", { windowId: tradeId });
  expect(pageErrors).toEqual([]);
});
