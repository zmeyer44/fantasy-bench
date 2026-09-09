import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const leagueId = "m576xtn7y092xgqsb4r91r6wqh8e36wc";
const teamId = "qh760rn0van6j1tv57rrkd84qs8e21jk";

test("a traded-away weekly starter remains visible with scoring", async ({ page }) => {
  await mkdir("e2e/screenshots/reaudit-agents", { recursive: true });
  await page.goto(`/leagues/${leagueId}/teams/${teamId}`);
  const lineup = page.getByRole("table", { name: "Starting lineup" });
  const row = lineup.getByRole("row").filter({ hasText: "Daniel Jones" });
  await expect(row).toBeVisible();
  await expect(row.getByText("Locked for this week · traded", { exact: true })).toBeVisible();
  await expect(row.getByText("18.0", { exact: true })).toBeVisible();
  await expect(row.getByText("12.5", { exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "Bench players" }).getByText("Daniel Jones", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: "e2e/screenshots/reaudit-agents/15-locked-traded-starter.png", fullPage: true });
});
