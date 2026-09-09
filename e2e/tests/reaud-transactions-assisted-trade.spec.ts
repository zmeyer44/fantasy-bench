import { execFile } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { promisify } from "node:util";

import { expect, test, type Page } from "@playwright/test";

const execFileAsync = promisify(execFile);
const screenshots = "e2e/screenshots/reaudit-transactions/assisted-trade";
const fixture = JSON.parse(readFileSync(".cache/reaud-assisted-repaired-fixture.json", "utf8")) as {
  email?: string;
  password?: string;
  leagueId: string;
  assistedTradeId: string;
  assistedAcceptorTeamId: string;
  assistedAcceptorRunId: string;
  assistedWindowId: string;
  teamAId: string;
  teamBId: string;
  playerAId: string;
  playerBId: string;
};
type Trade = { status: string; reviewEndsAt: number | null; events: Array<{ type: string }> };
type Team = {
  roster: Array<{ playerId: string }>;
  lineup: Array<{ slot: string; starting: boolean; entry: { playerId: string } | null }>;
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

async function shot(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${screenshots}/${name}.png`, fullPage: true });
}

test.beforeAll(() => mkdirSync(screenshots, { recursive: true }));

test("fixture-assisted counter is accepted, reviewed, transferred, and survives reload", async ({ page }) => {
  test.setTimeout(3 * 60_000);
  if (fixture.email && fixture.password) {
    await page.goto("/login");
    await page.getByLabel("Email").fill(fixture.email);
    await page.getByLabel("Password").fill(fixture.password);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL(/\/leagues$/, { timeout: 30_000 });
  }

  // This explicit backend-assisted response uses Team 7's real trade-window run context.
  let review = await convexRun<Trade>("trades:get", {
    leagueId: fixture.leagueId, tradeId: fixture.assistedTradeId,
  });
  if (review.status !== "completed") {
    const accepted = await convexRun<{ ok: boolean; status: string }>("trades:respond", {
      leagueId: fixture.leagueId,
      teamId: fixture.assistedAcceptorTeamId,
      tradeId: fixture.assistedTradeId,
      action: "accept",
      message: "Fixture-driven acceptance for deployed state-machine verification.",
      agentCtx: {
        runId: fixture.assistedAcceptorRunId,
        stepIndex: 1002,
        toolCallId: "reaud-fixture-accept-20260909",
        windowId: fixture.assistedWindowId,
        weekNo: 1,
      },
    });
    expect(accepted).toMatchObject({ ok: true, status: "in_review" });
    await page.goto(`/leagues/${fixture.leagueId}/trades/${fixture.assistedTradeId}`);
    await expect(page.getByText("In review", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Fairness score/i)).toBeVisible();
    await shot(page, "01-counter-accepted-in-review");
    review = await convexRun<Trade>("trades:get", {
      leagueId: fixture.leagueId, tradeId: fixture.assistedTradeId,
    });
    expect(review.status).toBe("in_review");
    expect(review.events.map((event) => event.type)).toEqual([
      "countered", "accepted", "fairness_scored",
    ]);
    expect(review.reviewEndsAt).toBeTruthy();

    // Advancing to the stored deadline exercises the real deployed review resolver and transfers.
    const resolved = await convexRun<{ resolved: number }>("trades:processReviews", {
      leagueId: fixture.leagueId, now: review.reviewEndsAt,
    });
    expect(resolved.resolved).toBe(1);
  } else {
    await page.goto(`/leagues/${fixture.leagueId}/trades/${fixture.assistedTradeId}`);
  }
  await page.reload();
  await expect(page.getByText("Completed", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await shot(page, "02-completed-after-reload");

  const [teamA, teamB, completed] = await Promise.all([
    convexRun<Team>("views:team", { teamId: fixture.teamAId }),
    convexRun<Team>("views:team", { teamId: fixture.teamBId }),
    convexRun<Trade>("trades:get", { leagueId: fixture.leagueId, tradeId: fixture.assistedTradeId }),
  ]);
  expect(teamA.roster.some((entry) => entry.playerId === fixture.playerBId)).toBe(true);
  expect(teamA.roster.some((entry) => entry.playerId === fixture.playerAId)).toBe(false);
  expect(teamB.roster.some((entry) => entry.playerId === fixture.playerAId)).toBe(true);
  expect(teamB.roster.some((entry) => entry.playerId === fixture.playerBId)).toBe(false);
  expect(teamA.lineup.find((slot) => slot.slot === "QB")?.entry?.playerId).toBe(fixture.playerBId);
  expect(teamB.lineup.find((slot) => slot.slot === "QB")?.entry?.playerId).toBe(fixture.playerAId);
  expect(completed.status).toBe("completed");
  expect(completed.events.map((event) => event.type)).toEqual([
    "countered", "accepted", "fairness_scored", "completed",
  ]);

  await page.goto(`/leagues/${fixture.leagueId}/teams/${fixture.teamAId}`);
  await expect(page.getByText("Joe Burrow", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Empty slot", { exact: true })).toHaveCount(0);
  await shot(page, "03-team-a-roster-after-transfer");
  await page.goto(`/leagues/${fixture.leagueId}/teams/${fixture.teamBId}`);
  await expect(page.getByText("Caleb Williams", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Empty slot", { exact: true })).toHaveCount(0);
  await shot(page, "04-team-b-roster-after-transfer");
});
