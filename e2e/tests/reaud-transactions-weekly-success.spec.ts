import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const execFileAsync = promisify(execFile);
const fixture = JSON.parse(readFileSync(".cache/reaud-drafts-full-fixture.json", "utf8")) as {
  email: string; password: string; leagueId: string;
};
function parse<T>(stdout: string): T {
  const starts = [stdout.indexOf("{"), stdout.indexOf("[")].filter((n) => n >= 0);
  return JSON.parse(stdout.slice(Math.min(...starts), Math.max(stdout.lastIndexOf("}"), stdout.lastIndexOf("]")) + 1)) as T;
}
async function run<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { stdout } = await execFileAsync("npx", ["convex", "run", name, JSON.stringify(args)], { cwd: process.cwd() });
  return parse<T>(stdout);
}
type Window = { id: string; runCount: number; terminalRunCount: number };
type Board = { teams: Array<{ id: string }> };
type Lineup = { slots: Array<{ slot: string; playerId: string | null }> };
type RunPage = { page: Array<{ windowId: string; status: string; outcome: string | null; actionCount: number }> };

test("current weekly window commits all eight complete lineups before Wednesday deadline", async ({ page }) => {
  test.setTimeout(3 * 60_000);
  const opened = await run<{ windowId: string }>("windows:openNow", {
    leagueId: fixture.leagueId, label: "lineup_weekly", weekNo: 2, roundNo: 1,
  });
  await expect.poll(async () => {
    const windows = await run<Window[]>("windows:forWeek", { leagueId: fixture.leagueId, weekNo: 2 });
    const window = windows.find((row) => row.id === opened.windowId);
    return window ? `${window.terminalRunCount}/${window.runCount}` : "missing";
  }, { timeout: 90_000 }).toBe("8/8");
  await run("windows:closeNow", { windowId: opened.windowId });

  const runs = await run<RunPage>("runs:list", {
    leagueId: fixture.leagueId, weekNo: 2, windowType: "lineup",
    paginationOpts: { numItems: 30, cursor: null },
  });
  const current = runs.page.filter((item) => item.windowId === opened.windowId);
  expect(current).toHaveLength(8);
  expect(current.every((item) => item.status === "succeeded" && item.outcome === "lineup_set" && item.actionCount >= 2)).toBe(true);

  const board = await run<Board>("draft:board", { leagueId: fixture.leagueId });
  for (const team of board.teams) {
    const lineup = await run<Lineup>("lineups:current", { teamId: team.id, weekNo: 2 });
    const starters = lineup.slots.filter((slot) => !["BENCH", "BN", "IR"].includes(slot.slot.toUpperCase()));
    expect(starters).toHaveLength(9);
    expect(starters.every((slot) => slot.playerId)).toBe(true);
  }

  await page.goto("/login");
  await page.getByLabel("Email").fill(fixture.email);
  await page.getByLabel("Password").fill(fixture.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.goto(`/leagues/${fixture.leagueId}/teams/${board.teams[0]!.id}`);
  await expect(page.getByText("Lineup weekly · wk 2", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("Succeeded", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Empty slot", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: "e2e/screenshots/reaudit-transactions/full-snake/09-current-weekly-lineup-success.png", fullPage: true });
});
