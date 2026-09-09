import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

import { expect, test, type Page } from "@playwright/test";

const execFileAsync = promisify(execFile);
const screenshots = "e2e/screenshots/reaudit-transactions/full-snake";
const fixturePath = ".cache/reaud-drafts-full-fixture.json";

type WindowView = { id: string; runCount: number; terminalRunCount: number };
type DraftBoard = {
  status: string;
  picksMade: number;
  totalPicks: number;
  teams: Array<{ id: string; name: string }>;
  picks: Array<{ playerId: string | null; auto: boolean; runId: string | null }>;
};
type TeamView = {
  team: { faabRemaining: number };
  roster: Array<{ playerId: string }>;
  lineup: Array<{ slot: string; starting: boolean; entry: { playerId: string } | null }>;
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

async function openWindow(leagueId: string, label: string, weekNo: number, roundNo: number) {
  let opened: { windowId: string } | null = null;
  await expect
    .poll(async () => {
      try {
        opened = await convexRun<{ windowId: string }>("windows:openNow", {
          leagueId,
          label,
          weekNo,
          roundNo,
        });
        return Boolean(opened?.windowId);
      } catch {
        return false;
      }
    }, { timeout: 60_000, intervals: [500, 1_000, 2_000, 3_000] })
    .toBe(true);
  return opened!;
}

async function waitForWindowRuns(leagueId: string, weekNo: number, windowId: string) {
  await expect
    .poll(async () => {
      const windows = await convexRun<WindowView[]>("windows:forWeek", { leagueId, weekNo });
      const window = windows.find((row) => row.id === windowId);
      return window ? `${window.terminalRunCount}/${window.runCount}` : "missing";
    }, { timeout: 90_000, intervals: [500, 1_000, 2_000, 3_000] })
    .toMatch(/^([1-9]\d*)\/\1$/);
}

async function shot(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${screenshots}/${name}.png`, fullPage: true });
}

test.beforeAll(() => mkdirSync(screenshots, { recursive: true }));

test("default eight-team snake draft produces full legal rosters and survives waivers", async ({ page }) => {
  test.setTimeout(40 * 60_000);
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const email = `reaud-full-snake-${suffix}@fantasybench.dev`;
  const password = `Qa-${randomUUID()}!`;
  const leagueName = `Reaudit Full Snake ${suffix}`;
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  // A unique commissioner and league isolate the 120 irreversible draft picks.
  await page.goto("/signup");
  await page.getByLabel("Name").fill("Full Draft Reaudit");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/leagues$/, { timeout: 30_000 });
  await page.getByLabel("League name").fill(leagueName);
  await page.getByLabel("Teams").selectOption("8");
  await page.getByLabel("Draft", { exact: true }).selectOption("snake");
  await page.getByRole("button", { name: "Create league" }).click();
  await expect(page).toHaveURL(/\/leagues\/[^/]+$/, { timeout: 30_000 });
  const leagueId = page.url().match(/\/leagues\/([^/?#]+)/)?.[1];
  expect(leagueId).toBeTruthy();
  writeFileSync(fixturePath, `${JSON.stringify({ email, password, leagueId, leagueName }, null, 2)}\n`, {
    mode: 0o600,
  });

  // All eight teams use the free deterministic model while default roster rules remain untouched.
  await page.goto(`/leagues/${leagueId}/settings`);
  await page.getByRole("tab", { name: "Models" }).click();
  await page.getByLabel("From (deprecated)").selectOption("openai/gpt-5.6-terra");
  await page.getByLabel("To (replacement)").selectOption("mock/scripted");
  await page.getByRole("button", { name: "Replace across the league" }).click();
  await expect(page.getByText("Updated 8 team(s).", { exact: true })).toBeVisible({ timeout: 30_000 });

  // The start review is the user-visible source of truth for the standard 15-player format.
  await page.goto(`/leagues/${leagueId}/draft`);
  await page.getByRole("button", { name: "Review and start" }).click();
  const review = page.getByRole("dialog");
  await expect(review.getByText("15 per team · 120 total", { exact: true })).toBeVisible();
  await expect(review.getByText("mock/scripted × 8", { exact: true })).toBeVisible();
  await shot(page, "01-default-start-review");
  await review.getByRole("button", { name: "Start snake draft" }).click();
  await expect(page.getByText("0 / 120", { exact: true })).toBeVisible({ timeout: 30_000 });

  // Each accelerated clock still waits for its real agent run to reach a terminal state.
  for (let pick = 1; pick <= 120; pick += 1) {
    const opened = await openWindow(leagueId!, "draft_pick", 0, pick);
    await waitForWindowRuns(leagueId!, 0, opened.windowId);
    await convexRun("windows:closeNow", { windowId: opened.windowId });
    await expect(page.getByText(`${pick} / 120`, { exact: true })).toBeVisible({ timeout: 45_000 });
    if (pick === 1) await shot(page, "02-first-agent-pick");
    if (pick === 60) await shot(page, "03-half-drafted");
  }

  const board = await convexRun<DraftBoard>("draft:board", { leagueId });
  expect(board.status).toBe("in_season");
  expect(board.picksMade).toBe(120);
  expect(board.totalPicks).toBe(120);
  expect(board.picks.every((pick) => pick.playerId && pick.runId && !pick.auto)).toBe(true);
  expect(new Set(board.picks.map((pick) => pick.playerId)).size).toBe(120);
  await expect(page.getByText("Draft complete", { exact: true })).toBeVisible();
  await shot(page, "04-full-draft-complete");

  // Draft finalization must fill all nine starters and all 15 roster spots for every team.
  for (const team of board.teams) {
    const view = await convexRun<TeamView>("views:team", { teamId: team.id });
    expect(view.roster, `${team.name} roster size`).toHaveLength(15);
    expect(view.lineupSource, `${team.name} lineup source`).toBe("draft_default");
    const starters = view.lineup.filter((slot) => slot.starting);
    expect(starters, `${team.name} starter count`).toHaveLength(9);
    expect(starters.every((slot) => slot.entry), `${team.name} starter coverage`).toBe(true);
  }

  const teamId = board.teams[0]!.id;
  await page.goto(`/leagues/${leagueId}/teams/${teamId}`);
  await expect(page.getByText("Empty slot", { exact: true })).toHaveCount(0);
  await shot(page, "05-default-roster-and-starters");

  // Waiver processing must preserve roster legality and a following lineup must report its real outcome.
  const before = await convexRun<TeamView>("views:team", { teamId });
  const waiver = await openWindow(leagueId!, "waiver", 1, 1);
  await waitForWindowRuns(leagueId!, 1, waiver.windowId);
  await page.goto(`/leagues/${leagueId}/waivers?week=1`);
  await page.getByRole("button", { name: "Claim activity" }).click();
  await expect(page.getByText("pending", { exact: true }).first()).toBeVisible({ timeout: 45_000 });
  await shot(page, "06-waiver-conflicts-pending");
  await convexRun("windows:closeNow", { windowId: waiver.windowId });
  await expect(page.getByText(/won|lost/, { exact: true }).first()).toBeVisible({ timeout: 45_000 });
  await shot(page, "07-waiver-results");

  const lineup = await openWindow(leagueId!, "lineup_weekly", 1, 1);
  await waitForWindowRuns(leagueId!, 1, lineup.windowId);
  await convexRun("windows:closeNow", { windowId: lineup.windowId });
  for (const team of board.teams) {
    const view = await convexRun<TeamView>("views:team", { teamId: team.id });
    expect(view.roster.length, `${team.name} roster capacity`).toBeLessThanOrEqual(15);
    expect(view.lineup.filter((slot) => slot.starting)).toHaveLength(9);
    expect(view.lineup.filter((slot) => slot.starting).every((slot) => slot.entry)).toBe(true);
    expect(view.recentRuns.some((run) => run.outcome === "lineup_incomplete")).toBe(false);
  }
  const after = await convexRun<TeamView>("views:team", { teamId });
  expect(after.team.faabRemaining).toBeLessThanOrEqual(before.team.faabRemaining);
  await page.goto(`/leagues/${leagueId}/teams/${teamId}`);
  await expect(page.getByText("Empty slot", { exact: true })).toHaveCount(0);
  await shot(page, "08-post-waiver-complete-lineup");
  expect(pageErrors).toEqual([]);
});
