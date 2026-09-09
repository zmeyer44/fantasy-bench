import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { promisify } from "node:util";

import { expect, test, type Page } from "@playwright/test";

// Historical checkpoint for the original TXN-02 reproduction. Its fixture
// intentionally contains the pre-fix two-quarterback roster, so it must not be
// used as a current behavior check. See audit-transactions-fixed-drafts.spec.ts.

const execFileAsync = promisify(execFile);
const fixturePath = ".cache/audit-transactions-fixture.json";
const screenshots = "e2e/screenshots/audit-transactions";

type Fixture = { email: string; password: string; leagueId: string };
type WindowView = { id: string; runCount: number; terminalRunCount: number };

function parseJson(stdout: string): unknown {
  const starts = [stdout.indexOf("{"), stdout.indexOf("[")].filter((at) => at >= 0);
  const first = Math.min(...starts);
  const last = Math.max(stdout.lastIndexOf("}"), stdout.lastIndexOf("]"));
  return JSON.parse(stdout.slice(first, last + 1));
}

async function convexRun<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { stdout } = await execFileAsync("npx", ["convex", "run", fn, JSON.stringify(args)], {
    cwd: process.cwd(),
    maxBuffer: 16 * 1024 * 1024,
  });
  return parseJson(stdout) as T;
}

async function openAndWait(leagueId: string, label: string, weekNo = 1) {
  const opened = await convexRun<{ windowId: string }>("windows:openNow", {
    leagueId,
    label,
    weekNo,
    roundNo: 1,
  });
  await expect
    .poll(
      async () => {
        const rows = await convexRun<WindowView[]>("windows:forWeek", { leagueId, weekNo });
        const row = rows.find((window) => window.id === opened.windowId);
        return row ? `${row.terminalRunCount}/${row.runCount}` : "missing";
      },
      { timeout: 90_000, intervals: [500, 1_000, 2_000, 3_000] },
    )
    .toMatch(/^([1-9]\d*)\/\1$/);
  return opened.windowId;
}

async function screenshot(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${screenshots}/${name}.png`, fullPage: true });
}

test.skip("legacy pre-fix checkpoint: post-waiver lineup and trade observations", async ({ page }) => {
  test.skip(!existsSync(fixturePath), "Run audit-transactions-agent-flows.spec.ts first.");
  test.setTimeout(5 * 60_000);
  mkdirSync(screenshots, { recursive: true });
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  // The checkpoint is a unique completed-draft league whose waiver claims were already processed.
  await page.goto("/login");
  await page.getByLabel("Email").fill(fixture.email);
  await page.getByLabel("Password").fill(fixture.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/leagues$/, { timeout: 30_000 });
  await page.goto(`/leagues/${fixture.leagueId}/teams`);
  const teamHref = await page.getByRole("link", { name: "Team 1", exact: true }).getAttribute("href");
  expect(teamHref).toBeTruthy();
  await page.goto(teamHref!);
  await expect(page.getByRole("definition").filter({ hasText: "$85" })).toBeVisible();
  await screenshot(page, "12-roster-after-agent-add-drop");

  // Observe the next agent-authored lineup after waiver drops alter the roster.
  const lineupWindowId = await openAndWait(fixture.leagueId, "lineup_sun_early");
  await convexRun("windows:closeNow", { windowId: lineupWindowId });
  await page.reload();
  await expect(page.getByText(/lineup sun early/i).first()).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText("Empty slot", { exact: true })).toBeVisible();
  await screenshot(page, "13-post-waiver-lineup");

  // Scripted agents publish proposals and responses without exposing human trade controls.
  const tradeWindowId = await openAndWait(fixture.leagueId, "trade_a");
  await page.goto(`/leagues/${fixture.leagueId}/trades`);
  await expect(page.getByRole("link", { name: "Details →" }).first()).toBeVisible({ timeout: 45_000 });
  await expect(
    page.getByRole("button", { name: /^(propose trade|accept|reject|counter)$/i }),
  ).toHaveCount(0);
  await screenshot(page, "14-agent-trade-feed");

  await page.getByRole("link", { name: "Details →" }).first().click();
  await expect(page.getByRole("heading", { name: /↔/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
  await expect(page.getByRole("link", { name: /trace/i }).first()).toBeVisible();
  await screenshot(page, "15-trade-detail-and-timeline");
  await convexRun("windows:closeNow", { windowId: tradeWindowId });

  // The completed draft locks roster shape in both copy and disabled controls.
  await page.goto(`/leagues/${fixture.leagueId}/settings`);
  await page.getByRole("tab", { name: "Rules" }).click();
  await expect(page.getByText("Rule set frozen", { exact: true })).toBeVisible();
  await expect(page.getByLabel("FLEX", { exact: true })).toBeDisabled();
  await screenshot(page, "16-post-draft-rules-frozen");

  expect(pageErrors).toEqual([]);
});
