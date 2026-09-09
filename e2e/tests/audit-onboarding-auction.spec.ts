import { mkdirSync } from "node:fs";

import { expect, test } from "@playwright/test";

// Preserve the original failure evidence under audit-onboarding/auction.
const screenshots = "e2e/screenshots/audit-onboarding/auction-fixed";

test("a commissioner can replace every auction agent with the scripted mock and start the first nomination", async ({
  page,
}) => {
  test.setTimeout(120_000);
  mkdirSync(screenshots, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const commissioner = {
    name: `QA Auction ${stamp.slice(-6)}`,
    email: `qa-auction-${stamp}@example.test`,
    password: `QA-Auction-${stamp}!`,
  };
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  // A unique account and league keep this irreversible draft start isolated from every retained fixture.
  await page.goto("/signup");
  await page.getByLabel("Name").fill(commissioner.name);
  await page.getByLabel("Email").fill(commissioner.email);
  await page.getByLabel("Password").fill(commissioner.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/leagues$/, { timeout: 20_000 });
  await page.getByLabel("League name").fill(`QA Auction ${stamp}`);
  await page.getByLabel("Teams").selectOption("8");
  await page.getByLabel("Scoring").selectOption("half_ppr");
  await page.getByLabel("Draft", { exact: true }).selectOption("auction");
  await page.getByRole("button", { name: "Create league" }).click();
  await expect(page).toHaveURL(/\/leagues\/[^/]+$/, { timeout: 30_000 });
  const leagueId = page.url().split("/").pop()!;
  await page.goto(`/leagues/${leagueId}/settings`);
  await expect(page.getByRole("heading", { name: "League settings" })).toBeVisible();

  // Replacing every active config with the zero-cost scripted model prevents real provider spend.
  await page.getByRole("tab", { name: "Models" }).click();
  const from = page.getByLabel("From (deprecated)");
  const to = page.getByLabel("To (replacement)");
  await expect(from.locator("option")).toHaveCount(2);
  await from.selectOption({ index: 1 });
  await to.selectOption("mock/scripted");
  await page.screenshot({ path: `${screenshots}/01-mock-replacement-ready.png`, fullPage: true });
  await page.getByRole("button", { name: "Replace across the league" }).click();
  await expect(page.getByText("Updated 8 team(s).")).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: `${screenshots}/02-all-agents-replaced.png`, fullPage: true });

  // The team ledger must prove every slot received a new mock-backed config version.
  await page.getByRole("tab", { name: "Teams" }).click();
  await expect(page.getByText(/mock\/scripted · v2/)).toHaveCount(8);
  await page.screenshot({ path: `${screenshots}/03-eight-mock-teams.png`, fullPage: true });

  // Starting now requires an explicit review of every frozen draft setting.
  await page.goto(`/leagues/${leagueId}/draft`);
  await expect(page.getByText("auction draft", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review and start" }).click();
  const review = page.getByRole("dialog");
  await expect(review.getByRole("heading", { name: "Review and start auction draft" })).toBeVisible();
  await expect(review.getByText("Auction · sealed bids", { exact: true })).toBeVisible();
  await expect(review.getByText("Half PPR", { exact: true })).toBeVisible();
  await expect(review.getByText("15 per team · 120 total", { exact: true })).toBeVisible();
  await expect(review.getByText("$200 per team", { exact: true })).toBeVisible();
  await expect(review.getByText("mock/scripted × 8", { exact: true })).toBeVisible();
  await expect(review.getByText(/Starting freezes scoring and roster rules/)).toBeVisible();
  await page.screenshot({ path: `${screenshots}/04-auction-start-review.png`, fullPage: true });

  // A live auction must expose the current nomination state immediately after startup.
  await review.getByRole("button", { name: "Start auction draft" }).click();
  await expect(page.getByText("live · updates as picks land")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Lot 1", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Live lot", { exact: true })).toBeVisible();
  await expect(page.getByText("Remaining draft dollars", { exact: true })).toBeVisible();
  await expect(page.getByText("$200", { exact: true })).toHaveCount(8);
  await page.screenshot({ path: `${screenshots}/05-live-auction-lot-visible.png`, fullPage: true });

  // The home schedule exposes the same real nomination window.
  await page.goto(`/leagues/${leagueId}`);
  await expect(page.getByText("auction draft in progress", { exact: true })).toBeVisible();
  await expect(page.getByText("Auction nominate", { exact: true }).first()).toBeVisible({
    timeout: 20_000,
  });
  await page.screenshot({ path: `${screenshots}/06-open-nomination-on-home.png`, fullPage: true });

  // A completed scripted run confirms the first agent nominated through the real backend at zero cost.
  await page.goto(`/leagues/${leagueId}/traces`);
  await expect(page.getByRole("heading", { name: "Traces" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Auction nominate · Team/ }).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("draft action recorded", { exact: false }).first()).toBeVisible({
    timeout: 30_000,
  });
  await page.screenshot({ path: `${screenshots}/07-first-mock-nomination-trace.png`, fullPage: true });

  // After the agent nominates, the board exposes the player, opening price, and sealed-bid state.
  await page.goto(`/leagues/${leagueId}/draft`);
  await expect(page.getByText("live · updates as picks land")).toBeVisible();
  await expect(page.getByText("Lot 1", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/opens at \$1/)).toBeVisible();
  await expect(page.getByText(/Agent bids are sealed/)).toBeVisible();
  await expect(page.getByText(/Bid amounts and participation remain hidden/)).toBeVisible();
  await page.screenshot({ path: `${screenshots}/08-post-nomination-board-visible.png`, fullPage: true });

  console.log(`AUCTION_AUDIT_LEAGUE_ID ${leagueId}`);
  expect(pageErrors).toEqual([]);
});
