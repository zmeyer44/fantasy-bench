import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { promisify } from "node:util";

import { expect, test, type Page } from "@playwright/test";

const execFileAsync = promisify(execFile);
const screenshots = "e2e/screenshots/audit-transactions/fixed";

type WindowView = {
  id: string;
  runCount: number;
  terminalRunCount: number;
};

type DraftBoard = {
  status: string;
  teams: Array<{ id: string; name: string }>;
  picks: Array<{
    playerId: string | null;
    price: number | null;
    auto: boolean;
    runId: string | null;
  }>;
  picksMade: number;
  totalPicks: number;
  auction: null | {
    phase: string;
    bidsSealed: true;
    currentLot: Record<string, unknown> | null;
    budgets: Array<{ teamId: string; remaining: number }>;
  };
};

type TeamView = {
  team: { faabRemaining: number };
  roster: Array<{ playerId: string }>;
  lineup: Array<{ starting: boolean; entry: { playerId: string } | null }>;
  lineupSource: string | null;
  recentRuns: Array<{ status: string; outcome: string | null }>;
};

function parseConvexJson(stdout: string): unknown {
  const objectAt = stdout.indexOf("{");
  const arrayAt = stdout.indexOf("[");
  const first = objectAt < 0 ? arrayAt : arrayAt < 0 ? objectAt : Math.min(objectAt, arrayAt);
  const last = Math.max(stdout.lastIndexOf("}"), stdout.lastIndexOf("]"));
  if (first < 0 || last < first) throw new Error(`Convex CLI returned no JSON: ${stdout}`);
  return JSON.parse(stdout.slice(first, last + 1));
}

async function convexRun<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { stdout } = await execFileAsync("npx", ["convex", "run", fn, JSON.stringify(args)], {
    cwd: process.cwd(),
    maxBuffer: 16 * 1024 * 1024,
  });
  return parseConvexJson(stdout) as T;
}

async function openWindow(
  leagueId: string,
  label: string,
  weekNo: number,
  roundNo: number,
): Promise<{ windowId: string }> {
  let opened: { windowId: string } | null = null;
  await expect
    .poll(
      async () => {
        try {
          opened = await convexRun<{ windowId: string }>("windows:openNow", {
            leagueId,
            label,
            weekNo,
            roundNo,
          });
          return Boolean(opened.windowId);
        } catch {
          return false;
        }
      },
      { timeout: 45_000, intervals: [500, 1_000, 2_000] },
    )
    .toBe(true);
  return opened!;
}

async function waitForWindowRuns(leagueId: string, weekNo: number, windowId: string) {
  await expect
    .poll(
      async () => {
        const windows = await convexRun<WindowView[]>("windows:forWeek", { leagueId, weekNo });
        const window = windows.find((row) => row.id === windowId);
        return window ? `${window.terminalRunCount}/${window.runCount}` : "missing";
      },
      { timeout: 90_000, intervals: [500, 1_000, 2_000, 3_000] },
    )
    .toMatch(/^([1-9]\d*)\/\1$/);
}

async function shot(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${screenshots}/${name}.png`, fullPage: true });
}

async function createLeague(page: Page, draft: "snake" | "auction") {
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const leagueName = `Fixed ${draft} QA ${suffix}`;
  await page.goto("/signup");
  await page.getByLabel("Name").fill("Fixed Draft QA");
  await page.getByLabel("Email").fill(`fixed-${draft}-${suffix}@fantasybench.dev`);
  await page.getByLabel("Password").fill(`Qa-${randomUUID()}!`);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/leagues$/, { timeout: 30_000 });

  await page.getByLabel("League name").fill(leagueName);
  await page.getByLabel("Teams").selectOption("8");
  await page.getByLabel("Draft", { exact: true }).selectOption(draft);
  await page.getByRole("button", { name: "Create league" }).click();
  await expect(page).toHaveURL(/\/leagues\/[^/]+$/, { timeout: 30_000 });
  const leagueId = page.url().match(/\/leagues\/([^/?#]+)/)?.[1];
  expect(leagueId).toBeTruthy();
  return { leagueId: leagueId!, leagueName };
}

async function configureLeague(page: Page, leagueId: string, bench: number) {
  await page.goto(`/leagues/${leagueId}/settings`);
  await page.getByRole("tab", { name: "Rules" }).click();
  for (const slot of ["QB", "RB", "WR", "TE", "SUPERFLEX", "K", "DEF"]) {
    await page.getByLabel(slot, { exact: true }).fill("0");
  }
  await page.getByLabel("FLEX", { exact: true }).fill("1");
  await page.getByLabel("BENCH", { exact: true }).fill(String(bench));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "Models" }).click();
  await page.getByLabel("From (deprecated)").selectOption("anthropic/claude-opus-5");
  await page.getByLabel("To (replacement)").selectOption("mock/scripted");
  await page.getByRole("button", { name: "Replace across the league" }).click();
  await expect(page.getByText("Updated 8 team(s).", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

async function reviewAndStart(
  page: Page,
  leagueId: string,
  draft: "snake" | "auction",
  rosterSize: number,
) {
  await page.goto(`/leagues/${leagueId}/draft`);
  await page.getByRole("button", { name: "Review and start" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: `Review and start ${draft} draft` })).toBeVisible();
  await expect(dialog.getByText(`${rosterSize} per team · ${rosterSize * 8} total`)).toBeVisible();
  await expect(dialog.getByText("PPR", { exact: true })).toBeVisible();
  await expect(dialog.getByText("mock/scripted × 8", { exact: true })).toBeVisible();
  await expect(dialog.getByText("8 unowned teams will draft with the configured default agents.")).toBeVisible();
  await expect(dialog.getByText(/Starting freezes scoring and roster rules/)).toBeVisible();
  await shot(page, `${draft}-01-start-review`);
  await dialog.getByRole("button", { name: `Start ${draft} draft` }).click();
  await expect(page.getByText("live · updates as picks land", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

test.beforeAll(() => mkdirSync(screenshots, { recursive: true }));

test("snake setup does not claim an empty board is complete", async ({ page }) => {
  const { leagueId } = await createLeague(page, "snake");
  await page.goto(`/leagues/${leagueId}/draft`);
  await expect(page.getByText("Not started", { exact: true })).toBeVisible();
  await expect(page.getByText("Draft complete", { exact: true })).toHaveCount(0);
  await shot(page, "snake-00-setup-not-started");
});

test("fixed snake draft keeps live ownership and produces usable lineups through waivers", async ({
  page,
}) => {
  test.setTimeout(15 * 60_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const { leagueId } = await createLeague(page, "snake");
  await configureLeague(page, leagueId, 1);
  await reviewAndStart(page, leagueId, "snake", 2);

  for (let pick = 1; pick <= 16; pick += 1) {
    const { windowId } = await openWindow(leagueId, "draft_pick", 0, pick);
    await waitForWindowRuns(leagueId, 0, windowId);
    await convexRun("windows:closeNow", { windowId });
    await expect(page.getByText(`${pick} / 16`, { exact: true })).toBeVisible({ timeout: 45_000 });
  }

  const board = await convexRun<DraftBoard>("draft:board", { leagueId });
  expect(board.picks).toHaveLength(16);
  expect(board.picks.every((pick) => pick.playerId && pick.runId && !pick.auto)).toBe(true);
  await shot(page, "snake-02-agent-complete");

  for (const team of board.teams) {
    const drafted = await convexRun<TeamView>("views:team", { teamId: team.id });
    expect(drafted.lineupSource, `${team.name} should have a draft-default lineup`).toBe(
      "draft_default",
    );
    expect(
      drafted.lineup.filter((slot) => slot.starting).every((slot) => slot.entry),
      `${team.name} should cover every starting slot`,
    ).toBe(true);
  }

  const teamId = board.teams.find((team) => team.name === "Team 1")!.id;
  const beforeWaivers = await convexRun<TeamView>("views:team", { teamId });
  expect(beforeWaivers.lineupSource).toBe("draft_default");
  expect(beforeWaivers.lineup.filter((slot) => slot.starting).every((slot) => slot.entry)).toBe(true);

  const waiver = await openWindow(leagueId, "waiver", 1, 1);
  await waitForWindowRuns(leagueId, 1, waiver.windowId);
  await convexRun("windows:closeNow", { windowId: waiver.windowId });
  const lineup = await openWindow(leagueId, "lineup_weekly", 1, 1);
  await waitForWindowRuns(leagueId, 1, lineup.windowId);
  await convexRun("windows:closeNow", { windowId: lineup.windowId });

  const afterWaivers = await convexRun<TeamView>("views:team", { teamId });
  expect(afterWaivers.team.faabRemaining).toBeLessThan(100);
  expect(afterWaivers.roster.map((entry) => entry.playerId)).not.toEqual(
    beforeWaivers.roster.map((entry) => entry.playerId),
  );
  expect(afterWaivers.lineup.filter((slot) => slot.starting).every((slot) => slot.entry)).toBe(true);
  expect(afterWaivers.recentRuns.some((run) => run.outcome === "lineup_incomplete")).toBe(false);
  await page.goto(`/leagues/${leagueId}/teams/${teamId}`);
  await expect(page.getByText("Empty slot", { exact: true })).toHaveCount(0);
  await shot(page, "snake-03-post-waiver-complete-lineup");
  expect(pageErrors).toEqual([]);
});

test("fixed auction board exposes every phase without leaking sealed bids and completes", async ({
  page,
}) => {
  test.setTimeout(20 * 60_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const { leagueId } = await createLeague(page, "auction");
  await configureLeague(page, leagueId, 0);
  await reviewAndStart(page, leagueId, "auction", 1);

  for (let lot = 1; lot <= 8; lot += 1) {
    const nomination = await openWindow(leagueId, "auction_nominate", 0, lot);
    await waitForWindowRuns(leagueId, 0, nomination.windowId);
    await convexRun("windows:closeNow", { windowId: nomination.windowId });

    const bid = await openWindow(leagueId, "auction_bid", 0, lot);
    await waitForWindowRuns(leagueId, 0, bid.windowId);
    const bidding = await convexRun<DraftBoard>("draft:board", { leagueId });
    expect(bidding.auction).toMatchObject({
      phase: "bidding",
      bidsSealed: true,
      currentLot: { lotNo: lot, status: "bidding" },
    });
    expect(Object.keys(bidding.auction?.currentLot ?? {})).not.toEqual(
      expect.arrayContaining(["bids", "bidAmounts", "bidderTeamIds", "submittedCount"]),
    );
    if (lot === 1) {
      await expect(page.getByText("Agent bids are sealed.", { exact: false })).toBeVisible();
      await shot(page, "auction-02-sealed-bidding");
    }
    await convexRun("windows:closeNow", { windowId: bid.windowId });
  }

  await expect
    .poll(async () => (await convexRun<DraftBoard>("draft:board", { leagueId })).status, {
      timeout: 60_000,
    })
    .toBe("in_season");
  const complete = await convexRun<DraftBoard>("draft:board", { leagueId });
  expect(complete.picksMade).toBe(8);
  expect(complete.totalPicks).toBe(8);
  expect(complete.picks.every((pick) => pick.playerId && pick.runId && pick.price === 5)).toBe(true);
  expect(new Set(complete.picks.map((pick) => pick.playerId))).toHaveProperty("size", 8);
  expect(complete.auction?.phase).toBe("complete");
  expect(complete.auction?.budgets.every((budget) => budget.remaining === 195)).toBe(true);
  await page.reload();
  await expect(page.getByText("Auction complete", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("8 / 8", { exact: true })).toBeVisible();
  await shot(page, "auction-03-complete");
  expect(pageErrors).toEqual([]);
});
