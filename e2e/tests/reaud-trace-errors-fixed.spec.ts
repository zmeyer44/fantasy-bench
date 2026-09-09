import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const leagueId = "m57ac9e2156bb7bqa56k1mad718e3vzs";
const runId = "pd7059w44b4c1sfbjs1f2s82jh8e37ep";

test("failed trace keeps one concise error and collapses raw diagnostics", async ({ page }) => {
  await mkdir("e2e/screenshots/reaudit-agents", { recursive: true });
  await page.goto(`/leagues/${leagueId}/traces/${runId}`);
  await expect(page.getByRole("heading", { name: /Forum.*Team 2/ })).toBeVisible();
  await expect(page.getByText("Technical diagnostics", { exact: true })).toBeVisible();
  const diagnostic = page.getByText("Technical diagnostics", { exact: true }).locator("xpath=..");
  await expect(diagnostic).not.toHaveAttribute("open", "");
  await expect(page.locator("pre").filter({ hasText: "GatewayError" })).not.toBeVisible();
  expect((await page.locator("body").innerText()).match(/\.\.\/\.\.\/node_modules/g) ?? []).toHaveLength(0);
  await page.screenshot({ path: "e2e/screenshots/reaudit-agents/11-failed-trace-diagnostics-collapsed.png", fullPage: true });
  await page.getByText("Technical diagnostics", { exact: true }).click();
  await expect(page.locator("pre").filter({ hasText: "GatewayError" })).toBeVisible();
  await page.screenshot({ path: "e2e/screenshots/reaudit-agents/12-failed-trace-diagnostics-open.png", fullPage: true });
});
