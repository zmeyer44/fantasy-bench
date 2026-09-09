import { expect, test, type Page } from "@playwright/test";

const screenshots = "e2e/screenshots/reaudit-onboarding";

test("rotated and full private invitations fail safely and explain the available path", async ({
  browser,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  test.setTimeout(240_000);
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const errors: string[] = [];
  const commissionerContext = await browser.newContext({ baseURL });
  const commissionerPage = await commissionerContext.newPage();
  commissionerPage.on("pageerror", (error) => errors.push(`commissioner: ${error.message}`));

  // A private eight-team fixture makes the full-invite spectator promise testable.
  await signUp(commissionerPage, {
    name: `Reaudit Invite Commissioner ${stamp.slice(-6)}`,
    email: `reaud-invite-commissioner-${stamp}@example.test`,
    password: `Reaudit-Invite-Commissioner-${stamp}!`,
  });
  const leagueName = `Reaudit Full Private ${stamp}`;
  await commissionerPage.getByLabel("League name").fill(leagueName);
  await commissionerPage.getByLabel("Teams").selectOption("8");
  await commissionerPage.getByRole("button", { name: "Create league" }).click();
  await expect(commissionerPage).toHaveURL(/\/leagues\/[^/]+$/, { timeout: 30_000 });
  const leagueId = commissionerPage.url().split("/").pop()!;
  await commissionerPage.goto(`/leagues/${leagueId}/settings`);
  await commissionerPage.getByRole("switch", { name: "Public league" }).click();
  await commissionerPage.getByRole("button", { name: "Save" }).click();
  await expect(commissionerPage.getByText("Saved.", { exact: true })).toBeVisible();
  const firstUrl = await commissionerPage.getByLabel("Invite link").inputValue();
  const firstPath = new URL(firstUrl).pathname;

  // Rotation must invalidate the previously shared URL while immediately publishing the replacement.
  await commissionerPage.getByRole("button", { name: "Rotate" }).click();
  await expect(commissionerPage.getByLabel("Invite link")).not.toHaveValue(firstUrl);
  const secondUrl = await commissionerPage.getByLabel("Invite link").inputValue();
  const secondPath = new URL(secondUrl).pathname;
  await commissionerPage.screenshot({ path: `${screenshots}/invite-01-rotated-code.png`, fullPage: true });
  const probeContext = await browser.newContext({ baseURL });
  const probePage = await probeContext.newPage();
  probePage.on("pageerror", (error) => errors.push(`probe: ${error.message}`));
  await probePage.goto(firstPath);
  await expect(probePage.getByRole("heading", { name: "We couldn’t find that page" })).toBeVisible();
  await probePage.screenshot({ path: `${screenshots}/invite-02-old-code-unavailable.png`, fullPage: true });
  await probePage.goto(secondPath.toLowerCase());
  await expect(probePage.getByRole("heading", { name: leagueName })).toBeVisible();
  await probePage.screenshot({ path: `${screenshots}/invite-03-lowercase-code-preview.png`, fullPage: true });
  await probeContext.close();

  // Eight isolated owners redeem the same current code exactly once and exhaust all teams.
  for (let index = 1; index <= 8; index += 1) {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(`owner-${index}: ${error.message}`));
    await signUp(page, {
      name: `Reaudit Full Owner ${index} ${stamp.slice(-6)}`,
      email: `reaud-full-owner-${index}-${stamp}@example.test`,
      password: `Reaudit-Full-Owner-${index}-${stamp}!`,
    });
    await page.goto(secondPath);
    await page.getByRole("button", { name: `Join ${leagueName}` }).click();
    await expect(page).toHaveURL(new RegExp(`/leagues/${leagueId}/teams/[^/]+/config$`), {
      timeout: 30_000,
    });
    if (index === 8) {
      await page.goto(secondPath);
      await expect(page.getByText("You are already in this league")).toBeVisible();
      await page.screenshot({ path: `${screenshots}/invite-04-eighth-owner-repeat-redemption.png`, fullPage: true });
    }
    await context.close();
  }

  // A ninth authenticated account gets a truthful private-full state without an inaccessible action.
  const ninthContext = await browser.newContext({ baseURL, viewport: { width: 320, height: 740 } });
  const ninthPage = await ninthContext.newPage();
  ninthPage.on("pageerror", (error) => errors.push(`ninth: ${error.message}`));
  await signUp(ninthPage, {
    name: `Reaudit Ninth Owner ${stamp.slice(-6)}`,
    email: `reaud-ninth-owner-${stamp}@example.test`,
    password: `Reaudit-Ninth-Owner-${stamp}!`,
  });
  await ninthPage.goto(secondPath);
  await expect(ninthPage.getByText("Every team is taken")).toBeVisible();
  await expect(ninthPage.getByText("This private league is full and is not open to spectators.")).toBeVisible();
  await expect(ninthPage.getByRole("button", { name: "Watch instead" })).toHaveCount(0);
  expect(await ninthPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await ninthPage.screenshot({ path: `${screenshots}/invite-05-full-private-safe-state.png`, fullPage: true });

  expect(errors.filter((message) => !message.includes("cannot have a negative time stamp"))).toEqual([]);
  await ninthContext.close();
  await commissionerContext.close();
});

async function signUp(
  page: Page,
  account: { name: string; email: string; password: string },
): Promise<void> {
  await page.goto("/signup");
  await page.getByLabel("Name").fill(account.name);
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/leagues$/, { timeout: 20_000 });
}
