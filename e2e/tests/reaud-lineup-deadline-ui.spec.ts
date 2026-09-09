import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";

const fixture = JSON.parse(readFileSync(".cache/qa-agents.json", "utf8")) as {
  email: string;
  password: string;
  leagueId: string;
  teamId: string;
};
const shots = "e2e/screenshots/reaudit-agents";

test("weekly lineup deadline is fixed in settings and visible on the team page", async ({ page }) => {
  await mkdir(shots, { recursive: true });
  await page.goto("/login");
  await page.getByLabel("Email").fill(fixture.email);
  await page.getByLabel("Password").fill(fixture.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/leagues$/);

  await page.goto(`/leagues/${fixture.leagueId}/settings`);
  await page.getByRole("tab", { name: "Windows" }).click();
  await expect(page.getByRole("heading", { name: "Weekly lineup deadline" })).toBeVisible();
  await expect(page.getByText("Hard lock · Wednesday 19:00 ET", { exact: true })).toBeVisible();
  await expect(page.getByText(/lineup_weekly.*Wednesday 16:00.*19:00 ET/)).toBeVisible();
  await expect(page.getByLabel(/Lineup (TNF|Sun|MNF)/)).toHaveCount(0);
  await expect(page.getByLabel(/Weekly lineup (opens|closes|submission|rounds|enabled)/)).toHaveCount(0);
  await page.screenshot({ path: `${shots}/13-fixed-weekly-lineup-settings.png`, fullPage: true });

  await page.goto(`/leagues/${fixture.leagueId}/teams/${fixture.teamId}`);
  await expect(page.getByText(/Hard deadline Wed 7:00 PM ET/)).toBeVisible();
  await page.screenshot({ path: `${shots}/14-team-weekly-lineup-deadline.png`, fullPage: true });
});
