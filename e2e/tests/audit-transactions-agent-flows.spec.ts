import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

import { expect, test, type Page } from "@playwright/test";

const execFileAsync = promisify(execFile);
// Preserve the original numbered audit evidence; reruns write current behavior separately.
const screenshots = "e2e/screenshots/audit-transactions/current-flow";
const fixturePath = ".cache/audit-transactions-fixture.json";

type WindowView = {
  id: string;
  label: string;
  roundNo: number;
  runCount: number;
  terminalRunCount: number;
  status: string;
};

type DraftBoard = {
  picks: Array<{ auto: boolean; runId: string | null; playerName: string | null }>;
};

function parseConvexJson(stdout: string): unknown {
  const start = stdout.indexOf("{");
  const arrayStart = stdout.indexOf("[");
  const first = start < 0 ? arrayStart : arrayStart < 0 ? start : Math.min(start, arrayStart);
  const endObject = stdout.lastIndexOf("}");
  const endArray = stdout.lastIndexOf("]");
  const last = Math.max(endObject, endArray);
  if (first < 0 || last < first) throw new Error(`Convex CLI returned no JSON: ${stdout}`);
  return JSON.parse(stdout.slice(first, last + 1));
}

async function convexRun<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { stdout } = await execFileAsync(
    "npx",
    ["convex", "run", fn, JSON.stringify(args)],
    { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 },
  );
  return parseConvexJson(stdout) as T;
}

async function openWindow(
  leagueId: string,
  label: string,
  weekNo: number,
  roundNo = 1,
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
      { timeout: 45_000, intervals: [500, 1_000, 2_000, 3_000] },
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

async function screenshot(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${screenshots}/${name}.png`, fullPage: true });
}

test("agents complete draft, waivers, lineups, and trades without human roster controls", async ({
  page,
}) => {
  test.setTimeout(15 * 60_000);
  mkdirSync(screenshots, { recursive: true });

  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const email = `audit-transactions-${suffix}@fantasybench.dev`;
  const password = `Qa-${randomUUID()}!`;
  const leagueName = `Transaction QA ${suffix}`;
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  // A disposable commissioner keeps every mutation isolated from the seeded demo league.
  await page.goto("/signup");
  await page.getByLabel("Name").fill("Transaction QA Commissioner");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/leagues$/, { timeout: 30_000 });

  await page.getByLabel("League name").fill(leagueName);
  await page.getByLabel("Teams").selectOption("8");
  await page.getByLabel("Draft").selectOption("snake");
  await page.getByRole("button", { name: "Create league" }).click();
  await expect(page).toHaveURL(/\/leagues\/[^/]+$/, { timeout: 30_000 });
  const leagueId = page.url().match(/\/leagues\/([^/?#]+)/)?.[1];
  expect(leagueId).toBeTruthy();
  writeFileSync(
    fixturePath,
    `${JSON.stringify({ email, password, leagueId, leagueName }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await expect(
    page.getByRole("button", { name: `League: ${leagueName}. Switch league` }),
  ).toBeVisible();
  await screenshot(page, "01-disposable-league-created");

  // A two-player FLEX roster keeps the real draft compact.
  await page.goto(`/leagues/${leagueId}/settings`);
  await page.getByRole("tab", { name: "Rules" }).click();
  for (const slot of ["QB", "RB", "WR", "TE", "SUPERFLEX", "K", "DEF"]) {
    await page.getByLabel(slot, { exact: true }).fill("0");
  }
  await page.getByLabel("FLEX", { exact: true }).fill("1");
  await page.getByLabel("BENCH", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  await screenshot(page, "02-compact-roster-rules-saved");

  // Commissioner replacement moves every unowned team's default config to the zero-cost model.
  await page.getByRole("tab", { name: "Models" }).click();
  await page.getByLabel("From (deprecated)").selectOption("anthropic/claude-opus-5");
  await page.getByLabel("To (replacement)").selectOption("mock/scripted");
  await page.getByRole("button", { name: "Replace across the league" }).click();
  await expect(page.getByText("Updated 8 team(s).", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await screenshot(page, "03-all-teams-scripted-model");

  // Starting from the public board validates the commissioner action and the live subscription.
  await page.goto(`/leagues/${leagueId}/draft`);
  await expect(page.getByText("0 / —", { exact: true })).toBeVisible();
  await screenshot(page, "04-draft-setup");
  await page.getByRole("button", { name: "Review and start" }).click();
  const startReview = page.getByRole("dialog");
  await expect(startReview.getByRole("heading", { name: "Review and start snake draft" })).toBeVisible();
  await expect(startReview.getByText("2 per team · 16 total", { exact: true })).toBeVisible();
  await startReview.getByRole("button", { name: "Start snake draft" }).click();
  await expect(page.getByText("live · updates as picks land", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(/Round 1, pick 1/)).toBeVisible();
  await screenshot(page, "05-draft-first-team-on-clock");

  // Each pick window gets a real scripted run; closing its clock advances the scheduler chain.
  for (let pick = 1; pick <= 16; pick += 1) {
    const { windowId } = await openWindow(leagueId!, "draft_pick", 0, pick);
    await waitForWindowRuns(leagueId!, 0, windowId);
    await convexRun("windows:closeNow", { windowId });
    await expect(page.getByText(`${pick} / 16`, { exact: true })).toBeVisible({ timeout: 45_000 });
    if (pick === 8) await screenshot(page, "06-draft-half-complete");
  }

  await expect(page.getByText("Draft complete", { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("16 / 16", { exact: true })).toBeVisible();
  const completedBoard = await convexRun<DraftBoard>("draft:board", { leagueId });
  expect.soft(completedBoard.picks.filter((pick) => pick.auto), "agent draft fell back to auto-picks").toHaveLength(0);
  expect.soft(completedBoard.picks.filter((pick) => pick.runId), "every agent pick should retain its trace").toHaveLength(16);
  await expect(page.getByRole("link", { name: "trace →" }).first()).toBeVisible();
  await screenshot(page, "07-draft-complete");

  // The commissioner can inspect a roster and agent trace, but receives no manual roster controls.
  await page.goto(`/leagues/${leagueId}/teams`);
  const teamLink = page.getByRole("link", { name: "Team 1", exact: true });
  await expect(teamLink).toBeVisible();
  const teamHref = await teamLink.getAttribute("href");
  expect(teamHref).toMatch(/\/teams\/[^/]+$/);
  await page.goto(teamHref!);
  await expect(page.getByRole("heading", { name: "Team 1", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /add|drop|trade|set lineup/i })).toHaveCount(0);
  await expect(page.getByText("Empty slot", { exact: true })).toHaveCount(0);
  await screenshot(page, "08-roster-after-draft");

  // A lineup window must turn the drafted roster into an agent-authored starter and bench view.
  const lineup = await openWindow(leagueId!, "lineup_weekly", 1);
  await waitForWindowRuns(leagueId!, 1, lineup.windowId);
  await convexRun("windows:closeNow", { windowId: lineup.windowId });
  await page.reload();
  await expect(page.getByText(/Set by agent/)).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("link", { name: "Trace →" }).first()).toBeVisible();
  await screenshot(page, "09-agent-lineup-and-bench");

  // All agents see one waiver snapshot and publish their pending FAAB claims live.
  const waiver = await openWindow(leagueId!, "waiver", 1);
  await waitForWindowRuns(leagueId!, 1, waiver.windowId);
  await page.goto(`/leagues/${leagueId}/waivers?week=1`);
  await page.getByRole("button", { name: "Claim activity" }).click();
  await expect(page.getByText("pending", { exact: true }).first()).toBeVisible({ timeout: 45_000 });
  await expect(
    page.getByRole("button", { name: /^(add player|submit claim|drop player)$/i }),
  ).toHaveCount(0);
  await screenshot(page, "10-waiver-claims-pending");

  // Closing the window processes claims atomically into won/lost results and roster transactions.
  await convexRun("windows:closeNow", { windowId: waiver.windowId });
  await expect(page.getByText("won", { exact: true }).first()).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText("lost", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Decision trace →" }).first()).toBeVisible();
  await screenshot(page, "11-waiver-claims-processed");

  await page.goto(teamHref!);
  await expect(page.getByRole("definition").filter({ hasText: "$90" })).toBeVisible({
    timeout: 45_000,
  });
  await screenshot(page, "12-roster-after-agent-add-drop");

  // A later lineup window proves the post-waiver roster can still be set through the agent tool.
  // There is one weekly lineup window per week and dispatch skips teams that
  // already ran in it, so the second lineup pass is week 2's window.
  const postWaiverLineup = await openWindow(leagueId!, "lineup_weekly", 2);
  await waitForWindowRuns(leagueId!, 2, postWaiverLineup.windowId);
  await convexRun("windows:closeNow", { windowId: postWaiverLineup.windowId });
  await page.reload();
  await expect(page.getByText(/Set by agent/)).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/weekly/i).first()).toBeVisible();
  await expect(page.getByText("Empty slot", { exact: true })).toHaveCount(0);
  await screenshot(page, "13-post-waiver-lineup");

  // Trade runs create proposals, responses, negotiation threads, and linked decision traces.
  const trade = await openWindow(leagueId!, "trade_a", 1);
  await waitForWindowRuns(leagueId!, 1, trade.windowId);
  await page.goto(`/leagues/${leagueId}/trades`);
  await expect(page.getByRole("link", { name: "Details →" }).first()).toBeVisible({
    timeout: 45_000,
  });
  await expect(page.getByRole("button", { name: /propose|accept|reject|counter/i })).toHaveCount(0);
  await screenshot(page, "14-agent-trade-feed");

  await page.getByRole("link", { name: "Details →" }).first().click();
  await expect(page.getByRole("heading", { name: /↔/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
  await expect(page.getByRole("link", { name: /trace/i }).first()).toBeVisible();
  await screenshot(page, "15-trade-detail-and-timeline");

  await convexRun("windows:closeNow", { windowId: trade.windowId });

  // Post-draft settings communicate that roster rules are frozen at both UI and control levels.
  await page.goto(`/leagues/${leagueId}/settings`);
  await page.getByRole("tab", { name: "Rules" }).click();
  await expect(page.getByText("Rule set frozen", { exact: true })).toBeVisible();
  await expect(page.getByLabel("FLEX", { exact: true })).toBeDisabled();
  await screenshot(page, "16-post-draft-rules-frozen");

  expect(pageErrors).toEqual([]);
});
