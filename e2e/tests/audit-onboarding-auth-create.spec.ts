import { expect, test } from "@playwright/test";

const screenshots = "e2e/screenshots/audit-onboarding";

test("a new commissioner can sign up, create a league, inspect its invite, and sign out", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const commissioner = {
    name: `QA Commissioner ${stamp.slice(-6)}`,
    email: `qa-onboarding-commissioner-${stamp}@example.test`,
    password: `QA-Onboarding-${stamp}!`,
  };
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  // A private console entry point must preserve the intended destination for a signed-out visitor.
  await page.goto("/leagues");
  await expect(page).toHaveURL(/\/login\?next=%2Fleagues$/);
  await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
  await page.screenshot({ path: `${screenshots}/01-signed-out-route-guard.png`, fullPage: true });

  // The alternate auth path must expose the complete account form without losing basic navigation.
  await page.getByRole("link", { name: "Sign up" }).click();
  await expect(page).toHaveURL(/\/signup\?next=%2Fleagues$/);
  await expect(page.getByRole("heading", { name: "Create an account" })).toBeVisible();
  await expect(page.getByLabel("Name")).toBeVisible();
  await page.screenshot({ path: `${screenshots}/02-signup-form.png`, fullPage: true });

  // A unique account keeps the real shared development backend safe for repeated QA runs.
  await page.getByLabel("Name").fill(commissioner.name);
  await page.getByLabel("Email").fill(commissioner.email);
  await page.getByLabel("Password").fill(commissioner.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/leagues$/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Your leagues" })).toBeVisible();
  await expect(page.getByText("No leagues yet")).toBeVisible();
  await expect(page.getByLabel("Invite code")).toBeVisible();
  await expect(page.getByRole("link", { name: "Join a league" })).toHaveAttribute(
    "href",
    "/leagues#join-league",
  );
  await page.screenshot({ path: `${screenshots}/03-new-account-empty-leagues.png`, fullPage: true });

  // Explicit non-default choices prove the create form applies the user's selections.
  const leagueName = `QA Onboarding ${stamp}`;
  await page.getByLabel("League name").fill(leagueName);
  await page.getByLabel("Teams").selectOption("8");
  await page.getByLabel("Scoring").selectOption("half_ppr");
  await page.getByLabel("Draft").selectOption("auction");
  await page.screenshot({ path: `${screenshots}/04-create-league-filled.png`, fullPage: true });
  await page.getByRole("button", { name: "Create league" }).click();
  await expect(page).toHaveURL(/\/leagues\/[^/]+$/, { timeout: 30_000 });
  const leagueId = page.url().split("/").pop()!;
  await expect(page.getByRole("button", { name: new RegExp(`League: ${leagueName}`) })).toBeVisible();
  await expect(page.getByText("auction draft not started", { exact: false })).toBeVisible();
  await page.screenshot({ path: `${screenshots}/05-new-league-home.png`, fullPage: true });

  // Commissioner settings must expose the invite while keeping administration out of public views.
  await page.getByRole("button", { name: "League settings" }).click();
  await expect(page).toHaveURL(`/leagues/${leagueId}/settings`);
  await expect(page.getByRole("heading", { name: "League settings" })).toBeVisible();
  const inviteInput = page.getByLabel("Invite link");
  await expect(inviteInput).toHaveValue(/\/leagues\/join\/[A-HJ-NP-Z2-9]{8}$/);
  const inviteUrl = await inviteInput.inputValue();
  const joinCode = inviteUrl.split("/").pop()!;
  await expect(page.getByText(joinCode, { exact: true })).toBeVisible();
  await page.screenshot({ path: `${screenshots}/06-commissioner-invite-settings.png`, fullPage: true });

  // The commissioner console must reflect every non-default create choice, including hidden rules.
  await page.getByRole("tab", { name: "Rules" }).click();
  await expect(page.getByLabel("Scoring preset")).toHaveValue("half_ppr");
  await expect(page.getByLabel("FAAB budget")).toHaveValue("100");
  await page.screenshot({ path: `${screenshots}/06a-created-rules-applied.png`, fullPage: true });
  await page.getByRole("tab", { name: "Teams" }).click();
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(9);
  await page.screenshot({ path: `${screenshots}/06b-created-eight-teams.png`, fullPage: true });
  await page.getByRole("tab", { name: "League", exact: true }).click();

  // Narrow-screen onboarding and settings must remain reachable without document-level overflow.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("tab", { name: "League", exact: true })).toBeVisible();
  await expect(page.getByText("Swipe for more settings →")).toBeVisible();
  const copyBox = await page.getByRole("button", { name: "Copy" }).boundingBox();
  const rotateBox = await page.getByRole("button", { name: "Rotate" }).boundingBox();
  expect(copyBox?.y).toBe(rotateBox?.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `${screenshots}/07-mobile-commissioner-settings.png`, fullPage: true });

  // Signing out must clear the session immediately and restore the protected-route guard.
  await page.getByRole("button", { name: new RegExp(`Account: ${commissioner.name}`) }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL("/");
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Get started" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `${screenshots}/08a-mobile-landing-header.png`, fullPage: true });
  await page.goto("/leagues");
  await expect(page).toHaveURL(/\/login\?next=%2Fleagues$/);
  await page.screenshot({ path: `${screenshots}/08-after-signout-route-guard.png`, fullPage: true });

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
