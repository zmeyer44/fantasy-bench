import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const shots = "e2e/screenshots/reaudit-agents";
const execFileAsync = promisify(execFile);
async function convexRun<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { stdout } = await execFileAsync("npx", ["convex", "run", fn, JSON.stringify(args)], { cwd: process.cwd() });
  const starts = [stdout.indexOf("{"), stdout.indexOf("[")].filter(i => i >= 0);
  if (starts.length === 0) return JSON.parse(stdout.trim()) as T;
  const start = Math.min(...starts);
  const end = Math.max(stdout.lastIndexOf("}"), stdout.lastIndexOf("]"));
  return JSON.parse(stdout.slice(start, end + 1)) as T;
}
async function snap(page: Page, name: string) {
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
}

test("regular owner config isolation, recovery, tools, budgets, and mobile boundaries", async ({ browser, baseURL }) => {
  test.setTimeout(360_000);
  if (!baseURL) throw new Error("baseURL required");
  await mkdir(shots, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const comm = JSON.parse(readFileSync(".cache/qa-agents.json", "utf8")) as { email: string; password: string };
  const owner = JSON.parse(readFileSync(".cache/audit-transactions-fixture.json", "utf8")) as { email: string; password: string };
  const league = `Reaud Agents ${stamp}`;
  const errors: string[] = [];
  const commCtx = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 } });
  const cp = await commCtx.newPage(); cp.on("pageerror", e => errors.push(`comm:${e.message}`));

  await cp.goto("/login");
  await cp.getByLabel("Email").fill(comm.email); await cp.getByLabel("Password").fill(comm.password);
  await cp.getByRole("button", { name: "Log in" }).click(); await expect(cp).toHaveURL(/\/leagues$/);
  await cp.getByLabel("League name").fill(league); await cp.getByLabel("Teams").selectOption("8"); await cp.getByRole("button", { name: "Create league" }).click();
  await expect(cp).toHaveURL(/\/leagues\/[^/]+$/); const leagueId = cp.url().split("/").pop()!;
  await cp.goto(`/leagues/${leagueId}/settings`); const invite = await cp.getByLabel("Invite link").inputValue();
  await cp.goto(`/leagues/${leagueId}/teams`);
  const initialTeamLinks = await cp.getByRole("link", { name: /^Team \d+$/ }).evaluateAll(as => [...new Set(as.map(a => a.getAttribute("href")).filter(Boolean))] as string[]);
  for (const href of initialTeamLinks) {
    await cp.goto(`${href}/config?tab=model`); await cp.getByLabel("Model", { exact: true }).selectOption("mock/scripted");
    await cp.getByLabel("Change summary").fill(`mock-only audit ${stamp}`); await cp.getByRole("button", { name: "Save changes" }).click(); await expect(cp.getByRole("status")).toContainText("Changes saved");
  }

  const ownerCtx = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  const op = await ownerCtx.newPage(); op.on("pageerror", e => errors.push(`owner:${e.message}`));
  const invitePath = new URL(invite).pathname;
  await op.goto(`/login?next=${encodeURIComponent(invitePath)}`); await op.getByLabel("Email").fill(owner.email); await op.getByLabel("Password").fill(owner.password);
  await op.getByRole("button", { name: "Log in" }).click(); await expect(op).toHaveURL(/\/leagues\/join\//);
  await op.getByRole("button", { name: new RegExp(`Join ${league}`) }).click(); await expect(op).toHaveURL(new RegExp(`/leagues/${leagueId}/teams/[^/]+/config$`));
  const ownerTeamId = op.url().split("/").at(-2)!;

  const context = `# Owner-only strategy ${stamp}\n\nPrefer floor, preserve FAAB, and explain injury risk.`;
  const editor = op.getByLabel("Agent context"); await expect(editor).toBeEditable(); await editor.fill(context);
  await op.getByRole("tab", { name: "Model & harness" }).click();
  await op.getByLabel("Max steps").fill("6"); await op.getByLabel("Token budget per run").fill("9000"); await op.getByLabel("Temperature").fill("0.7");
  await op.getByRole("tab", { name: "Prompt" }).click(); await op.getByLabel("Change summary").fill(`regular owner save ${stamp}`);
  await op.getByRole("button", { name: "Save changes" }).click(); await expect(op.getByRole("status")).toContainText("Changes saved");
  await snap(op, "01-owner-save-mobile"); await op.reload(); await expect(editor).toHaveValue(context);

  await op.getByRole("link", { name: "Versions" }).click(); await expect(op.getByText(`regular owner save ${stamp}`)).toBeVisible(); await snap(op, "02-owner-version-history-mobile");
  await op.goto(`/leagues/${leagueId}/teams/${ownerTeamId}/config/tools/search_players`);
  await op.getByLabel("Owner guidance").fill(`Rank healthy free agents first ${stamp}`); await op.getByLabel("Change summary").fill(`tool guide ${stamp}`);
  await op.getByRole("button", { name: "Save changes" }).click(); await expect(op.getByRole("status")).toContainText("Changes saved");
  await snap(op, "03-owner-tool-guidance");
  const reset = op.getByRole("button", { name: /Reset|Restore default/i });
  if (await reset.count()) {
    await reset.click(); await expect(op.getByLabel("Owner guidance")).toHaveValue(""); await expect(op.getByRole("status")).toHaveCount(0); await snap(op, "04-owner-tool-reset");
    await op.reload(); await expect(op.getByLabel("Owner guidance")).not.toHaveValue(""); await snap(op, "04b-owner-tool-reset-reloaded");
    await reset.click(); await op.getByLabel("Change summary").fill(`persist reset ${stamp}`); await op.getByRole("button", { name: "Save changes" }).click();
    await expect(op.getByRole("status")).toContainText("Changes saved"); await op.reload(); await expect(op.getByLabel("Owner guidance")).toHaveValue("");
  }

  // A regular owner must see another team's configuration as read-only even by direct URL.
  await cp.goto(`/leagues/${leagueId}/teams`); const teamLinks = await cp.getByRole("link", { name: /^Team \d+$/ }).evaluateAll(as => as.map(a => a.getAttribute("href")).filter(Boolean));
  const otherHref = teamLinks.find(h => h && !h.includes(ownerTeamId))!;
  await op.goto(`${otherHref}/config`); await expect(op.getByRole("heading", { name: "Under wraps" })).toBeVisible(); await expect(op.getByLabel("Agent context")).toHaveCount(0);
  await snap(op, "05-other-team-readonly-mobile"); expect(await op.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // Commissioner budget fields must reject values outside their documented bounds instead of silently persisting them.
  await cp.goto(`/leagues/${leagueId}/settings`); await cp.getByRole("tab", { name: "Budgets" }).click();
  await cp.getByLabel("Weekly spend cap per team (USD)").fill("-1"); await cp.getByLabel("Weekly token cap per team").fill("999"); await cp.getByLabel("League USD hard cap").fill("-5");
  await snap(cp, "06-invalid-budgets-filled"); await cp.getByRole("tabpanel", { name: "Budgets" }).getByRole("button", { name: "Save" }).click();
  expect(await cp.getByLabel("Weekly spend cap per team (USD)").evaluate((e: HTMLInputElement) => e.validity.valid)).toBe(false);
  expect(await cp.getByLabel("Weekly token cap per team").evaluate((e: HTMLInputElement) => e.validity.valid)).toBe(false);
  await snap(cp, "07-invalid-budgets-rejected"); await cp.reload(); await cp.getByRole("tab", { name: "Budgets" }).click();
  await expect(cp.getByLabel("Weekly spend cap per team (USD)")).not.toHaveValue("-1"); await expect(cp.getByLabel("Weekly token cap per team")).not.toHaveValue("999");

  // Exercise the real unlock promotion helper, then prove a no-cost window records the promoted immutable version.
  expect(await convexRun<number>("configs:applyPending", { leagueId })).toBeGreaterThan(0);
  for (const href of initialTeamLinks) {
    await cp.goto(`${href}/config?tab=model`); await expect(cp.getByLabel("Model", { exact: true })).toHaveValue("mock/scripted");
  }
  // Round 1 is already past at this fixture clock, so opening it immediately closes
  // without dispatching. Round 3 is the first unopened future forum template.
  const opened = await convexRun<{ windowId: string }>("windows:openNow", {
    leagueId, label: "forum", weekNo: 1, roundNo: 3,
  });
  await expect.poll(async () => {
    const windows = await convexRun<Array<{ id: string; runCount: number; terminalRunCount: number }>>("windows:forWeek", { leagueId, weekNo: 1 });
    const w = windows.find(row => row.id === opened.windowId); return w ? `${w.terminalRunCount}/${w.runCount}` : "missing";
  }, { timeout: 90_000, intervals: [500, 1000, 2000] }).toMatch(/^([1-9]\d*)\/\1$/);
  await convexRun("windows:closeNow", { windowId: opened.windowId });
  await op.goto(`/leagues/${leagueId}/teams/${ownerTeamId}/config/versions`);
  await expect(op.getByText("Applied", { exact: true }).first()).toBeVisible(); await expect(op.getByText("Queued", { exact: true })).toHaveCount(0); await snap(op, "08-promoted-version-history");
  await op.goto(`/leagues/${leagueId}/traces`); await expect(op.getByText(/run/).first()).toBeVisible(); await snap(op, "09-promoted-window-traces");
  await op.getByRole("link").filter({ hasText: /Forum.*Team 1/ }).first().click(); await expect(op.getByRole("heading", { name: "Prompt" })).toBeVisible();
  await op.getByText("Owner context", { exact: true }).click(); await expect(op.getByText(context, { exact: false })).toBeVisible(); await expect(op.getByText(/^\$0\.0+$/).first()).toBeVisible(); await snap(op, "10-promoted-run-context-zero-cost");

  expect(errors).toEqual([]); await ownerCtx.close(); await commCtx.close();
});
