import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { promisify } from "node:util";

import { expect, test, type Page } from "@playwright/test";

const execFileAsync = promisify(execFile);
const screenshots = "e2e/screenshots/reaudit-onboarding/auction";

type WindowView = { id: string; runCount: number; terminalRunCount: number };
type AvailableView = { players: Array<{ id: string }> };
type DraftBoard = {
  status: string;
  teams: Array<{ id: string; name: string }>;
  picks: Array<{
    playerId: string | null;
    teamId?: string;
    price: number | null;
    auto: boolean;
    runId: string | null;
  }>;
  picksMade: number;
  totalPicks: number;
  auction: null | {
    phase: string;
    bidsSealed: true;
    currentLot: null | {
      lotNo: number;
      status: string;
      playerId: string | null;
      openingBid: number;
    };
    budgets: Array<{ teamId: string; remaining: number }>;
  };
  startReview: {
    draftBudget: number;
    rosterSize: number;
    modelAssignments: Array<{ modelId: string; teamCount: number; paid: boolean }>;
  };
};
type TeamView = { roster: Array<{ playerId: string }> };

function parseConvexJson(stdout: string): unknown {
  const objectAt = stdout.indexOf("{");
  const arrayAt = stdout.indexOf("[");
  const first = objectAt < 0 ? arrayAt : arrayAt < 0 ? objectAt : Math.min(objectAt, arrayAt);
  const last = Math.max(stdout.lastIndexOf("}"), stdout.lastIndexOf("]"));
  if (first < 0 || last < first) throw new Error("Convex CLI returned no JSON payload");
  return JSON.parse(stdout.slice(first, last + 1));
}

async function convexRun<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { stdout } = await execFileAsync("npx", ["convex", "run", fn, JSON.stringify(args)], {
    cwd: process.cwd(),
    maxBuffer: 16 * 1024 * 1024,
  });
  return parseConvexJson(stdout) as T;
}

async function openWindow(leagueId: string, label: string, lot: number) {
  let opened: { windowId: string } | null = null;
  await expect.poll(async () => {
    try {
      opened = await convexRun<{ windowId: string }>("windows:openNow", {
        leagueId,
        label,
        weekNo: 0,
        roundNo: lot,
      });
      return Boolean(opened.windowId);
    } catch {
      return false;
    }
  }, { timeout: 45_000, intervals: [500, 1_000, 2_000] }).toBe(true);
  return opened!;
}

async function waitForRuns(leagueId: string, windowId: string) {
  await expect.poll(async () => {
    const windows = await convexRun<WindowView[]>("windows:forWeek", { leagueId, weekNo: 0 });
    const window = windows.find((row) => row.id === windowId);
    return window ? `${window.terminalRunCount}/${window.runCount}` : "missing";
  }, { timeout: 90_000, intervals: [500, 1_000, 2_000, 3_000] }).toMatch(/^([1-9]\d*)\/\1$/);
}

async function shot(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${screenshots}/${name}.png`, fullPage: true });
}

test.beforeAll(() => mkdirSync(screenshots, { recursive: true }));

test("compact 16-lot scripted auction preserves ownership, budgets, privacy, and completion", async ({
  page,
  browser,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  test.setTimeout(20 * 60_000);
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const leagueName = `Reaudit Auction ${suffix}`;
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  // A disposable commissioner and league keep all 16 awards away from seeded fixtures.
  await page.goto("/signup");
  await page.getByLabel("Name").fill("Reaudit Auction Commissioner");
  await page.getByLabel("Email").fill(`reaud-auction-${suffix}@example.test`);
  await page.getByLabel("Password").fill(`Reaudit-Auction-${randomUUID()}!`);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/leagues$/, { timeout: 30_000 });
  await page.getByLabel("League name").fill(leagueName);
  await page.getByLabel("Teams").selectOption("8");
  await page.getByLabel("Draft", { exact: true }).selectOption("auction");
  await page.getByRole("button", { name: "Create league" }).click();
  await expect(page).toHaveURL(/\/leagues\/[^/]+$/, { timeout: 30_000 });
  const leagueId = page.url().match(/\/leagues\/([^/?#]+)/)![1];

  // Two roster slots per team produce exactly 16 lots; every actual config is replaced with Scripted Mock.
  await page.goto(`/leagues/${leagueId}/settings`);
  await page.getByRole("tab", { name: "Rules" }).click();
  for (const slot of ["QB", "RB", "WR", "TE", "SUPERFLEX", "K", "DEF"]) {
    await page.getByLabel(slot, { exact: true }).fill("0");
  }
  await page.getByLabel("FLEX", { exact: true }).fill("1");
  await page.getByLabel("BENCH", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Models" }).click();
  await page.getByLabel("From (deprecated)").selectOption("anthropic/claude-opus-5");
  await page.getByLabel("To (replacement)").selectOption("mock/scripted");
  await page.getByRole("button", { name: "Replace across the league" }).click();
  await expect(page.getByText("Updated 8 team(s).", { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("tab", { name: "Teams" }).click();
  await expect(page.getByText(/mock\/scripted · v2/)).toHaveCount(8);

  // Settings must use the same current-config review gate as the draft board before it can start.
  await page.getByRole("tab", { name: "League", exact: true }).click();
  await expect(page.getByRole("button", { name: "Review and start" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Review and start" }).click();
  const review = page.getByRole("dialog");
  await expect(review.getByRole("heading", { name: "Review and start auction draft" })).toBeVisible();
  await expect(review.getByText("2 per team · 16 total")).toBeVisible();
  await expect(review.getByText("mock/scripted × 8")).toBeVisible();
  await expect(review.getByText("$200 per team")).toBeVisible();
  await expect(review.getByText("8 unowned teams will draft with the configured default agents.")).toBeVisible();
  await shot(page, "01-settings-start-review");
  await review.getByRole("button", { name: "Start auction draft" }).click();
  await expect(review).toHaveCount(0);
  await expect.poll(async () => (await convexRun<DraftBoard>("draft:board", { leagueId })).status, {
    timeout: 30_000,
  }).toBe("drafting");
  const initial = await convexRun<DraftBoard>("draft:board", { leagueId });
  expect(initial.startReview.rosterSize).toBe(2);
  expect(initial.totalPicks).toBe(16);
  expect(initial.startReview.modelAssignments).toEqual([
    { modelId: "mock/scripted", teamCount: 8, paid: false },
  ]);
  expect(initial.startReview.draftBudget).toBe(200);

  const spectator = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  const spectatorPage = await spectator.newPage();
  spectatorPage.on("pageerror", (error) => pageErrors.push(`spectator: ${error.message}`));
  await spectatorPage.goto(`/leagues/${leagueId}/draft`);
  let priorBudgets = new Map(initial.auction!.budgets.map((row) => [row.teamId, row.remaining]));
  const awarded = new Set<string>();

  for (let lot = 1; lot <= 16; lot += 1) {
    // The nomination window must commit one still-available player for this lot.
    const availableBefore = await convexRun<AvailableView>("waivers:available", { leagueId });
    const nomination = await openWindow(leagueId, "auction_nominate", lot);
    await waitForRuns(leagueId, nomination.windowId);
    await convexRun("windows:closeNow", { windowId: nomination.windowId });
    const nominated = await convexRun<DraftBoard>("draft:board", { leagueId });
    expect(nominated.auction).toMatchObject({
      phase: "bidding",
      bidsSealed: true,
      currentLot: { lotNo: lot, status: "bidding" },
    });
    const playerId = nominated.auction!.currentLot!.playerId!;
    expect(availableBefore.players.some((player) => player.id === playerId)).toBe(true);
    expect(awarded.has(playerId)).toBe(false);

    // Sealed submissions expose no bidder identity/count/amount and reserve no public spend before award.
    const bid = await openWindow(leagueId, "auction_bid", lot);
    await waitForRuns(leagueId, bid.windowId);
    const bidding = await convexRun<DraftBoard>("draft:board", { leagueId });
    expect(Object.keys(bidding.auction!.currentLot!)).not.toEqual(
      expect.arrayContaining(["bids", "bidAmounts", "bidderTeamIds", "submittedCount"]),
    );
    expect(new Map(bidding.auction!.budgets.map((row) => [row.teamId, row.remaining]))).toEqual(priorBudgets);
    if (lot === 1 || lot === 16) {
      await spectatorPage.reload();
      await expect(spectatorPage.getByText("Agent bids are sealed.", { exact: false })).toBeVisible();
      await shot(spectatorPage, lot === 1 ? "02-first-sealed-bid" : "03-final-sealed-bid");
    }
    await convexRun("windows:closeNow", { windowId: bid.windowId });

    // Resolution must award exactly one new player, remove it from availability, and debit one winner only.
    await expect.poll(async () => (await convexRun<DraftBoard>("draft:board", { leagueId })).picksMade, {
      timeout: 30_000,
      intervals: [250, 500, 1_000],
    }).toBe(lot);
    const resolved = await convexRun<DraftBoard>("draft:board", { leagueId });
    expect(resolved.picksMade).toBe(lot);
    const pick = resolved.picks[resolved.picks.length - 1]!;
    expect(pick.playerId).toBe(playerId);
    expect(pick.auto).toBe(false);
    expect(pick.runId).toBeTruthy();
    expect(pick.price).toBe(5);
    awarded.add(playerId);
    const availableAfter = await convexRun<AvailableView>("waivers:available", { leagueId });
    expect(availableAfter.players.some((player) => player.id === playerId)).toBe(false);
    const nextBudgets = new Map(resolved.auction!.budgets.map((row) => [row.teamId, row.remaining]));
    expect([...nextBudgets.values()].reduce((sum, value) => sum + value, 0)).toBe(
      [...priorBudgets.values()].reduce((sum, value) => sum + value, 0) - 5,
    );
    priorBudgets = nextBudgets;
  }

  // Completion requires 16 unique awards, two roster spots per team, and budget left for every team.
  await expect.poll(async () => (await convexRun<DraftBoard>("draft:board", { leagueId })).status, {
    timeout: 60_000,
  }).toBe("in_season");
  const complete = await convexRun<DraftBoard>("draft:board", { leagueId });
  expect(complete.picksMade).toBe(16);
  expect(complete.totalPicks).toBe(16);
  expect(complete.auction?.phase).toBe("complete");
  expect(complete.auction?.budgets.every((budget) => budget.remaining === 190)).toBe(true);
  expect(awarded.size).toBe(16);
  expect(new Set(complete.picks.map((pick) => pick.playerId)).size).toBe(16);
  for (const team of complete.teams) {
    const view = await convexRun<TeamView>("views:team", { teamId: team.id });
    expect(view.roster, `${team.name} roster`).toHaveLength(2);
    expect(new Set(view.roster.map((row) => row.playerId)).size).toBe(2);
  }
  await spectatorPage.reload();
  await expect(spectatorPage.getByText("Auction complete", { exact: true }).first()).toBeVisible();
  await expect(spectatorPage.getByText("16 / 16", { exact: true })).toBeVisible();
  await shot(spectatorPage, "04-complete-16-of-16");

  expect(pageErrors).toEqual([]);
  await spectator.close();
});
