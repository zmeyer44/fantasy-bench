import { expect, test } from "@playwright/test";

const screenshots = "e2e/screenshots/audit-onboarding";

test("an invited new owner can recover from auth handoff, claim a team, and cannot administer", async ({
  browser,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  test.setTimeout(180_000);
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const commissioner = {
    name: `Invite Commissioner ${stamp.slice(-6)}`,
    email: `qa-onboarding-invite-commissioner-${stamp}@example.test`,
    password: `QA-Invite-Commissioner-${stamp}!`,
  };
  const owner = {
    name: `Invite Owner ${stamp.slice(-6)}`,
    email: `qa-onboarding-invite-owner-${stamp}@example.test`,
    password: `QA-Invite-Owner-${stamp}!`,
  };
  const leagueName = `QA Invite ${stamp}`;
  const browserErrors: string[] = [];

  const commissionerContext = await browser.newContext({ baseURL, viewport: { width: 1280, height: 800 } });
  const commissionerPage = await commissionerContext.newPage();
  commissionerPage.on("pageerror", (error) => browserErrors.push(`commissioner: ${error.message}`));

  // A disposable commissioner provides a real invite without changing any shared league fixture.
  await commissionerPage.goto("/signup");
  await commissionerPage.getByLabel("Name").fill(commissioner.name);
  await commissionerPage.getByLabel("Email").fill(commissioner.email);
  await commissionerPage.getByLabel("Password").fill(commissioner.password);
  await commissionerPage.getByRole("button", { name: "Create account" }).click();
  await expect(commissionerPage).toHaveURL(/\/leagues$/, { timeout: 20_000 });
  await commissionerPage.getByLabel("League name").fill(leagueName);
  await commissionerPage.getByLabel("Teams").selectOption("8");
  await commissionerPage.getByRole("button", { name: "Create league" }).click();
  await expect(commissionerPage).toHaveURL(/\/leagues\/[^/]+$/, { timeout: 30_000 });
  const leagueId = commissionerPage.url().split("/").pop()!;
  await commissionerPage.goto(`/leagues/${leagueId}/settings`);
  const inviteInput = commissionerPage.getByLabel("Invite link");
  await expect(inviteInput).toHaveValue(/\/leagues\/join\/[A-HJ-NP-Z2-9]{8}$/);
  const inviteUrl = await inviteInput.inputValue();
  const invitePath = new URL(inviteUrl).pathname;
  const joinCode = invitePath.split("/").pop()!;

  const ownerContext = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  const ownerPage = await ownerContext.newPage();
  ownerPage.on("pageerror", (error) => browserErrors.push(`owner: ${error.message}`));

  // An invite holder must be able to identify the league before creating an account.
  await ownerPage.goto(invitePath);
  await expect(ownerPage.getByRole("heading", { name: leagueName })).toBeVisible();
  await expect(ownerPage.getByText("Sign in to join")).toBeVisible();
  await expect(ownerPage.getByText("8 teams")).toBeVisible();
  const hydrationScrollWidth = await ownerPage.evaluate(() => document.documentElement.scrollWidth);
  expect(hydrationScrollWidth).toBeLessThanOrEqual(390);
  await ownerPage.screenshot({
    path: `${screenshots}/09a-mobile-anonymous-invite-auth-loading.png`,
    fullPage: true,
  });
  await expect(
    ownerPage
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "Get started" }),
  ).toBeVisible();
  expect(await ownerPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await ownerPage.screenshot({ path: `${screenshots}/09-mobile-anonymous-invite.png`, fullPage: true });

  // The sign-in handoff must carry the invite destination in its next parameter.
  await ownerPage.getByRole("button", { name: "Sign in" }).click();
  await expect(ownerPage).toHaveURL(new RegExp(`/login\\?next=%2Fleagues%2Fjoin%2F${joinCode}$`));
  await expect(
    ownerPage
      .getByLabel("Loading authentication form")
      .or(ownerPage.getByRole("heading", { name: "Log in" })),
  ).toBeVisible();
  await ownerPage.screenshot({ path: `${screenshots}/10-invite-login-handoff.png`, fullPage: true });

  // Switching auth modes must preserve the invitation for a first-time owner.
  await ownerPage.getByRole("link", { name: "Sign up" }).click();
  await expect(ownerPage).toHaveURL(new RegExp(`/signup\\?next=%2Fleagues%2Fjoin%2F${joinCode}$`));
  await ownerPage.screenshot({ path: `${screenshots}/11-invite-destination-preserved-on-signup.png`, fullPage: true });

  // Successful signup must return to the invitation instead of stranding the owner in an empty console.
  await ownerPage.getByLabel("Name").fill(owner.name);
  await ownerPage.getByLabel("Email").fill(owner.email);
  await ownerPage.getByLabel("Password").fill(owner.password);
  await ownerPage.getByRole("button", { name: "Create account" }).click();
  await expect(ownerPage).toHaveURL(new RegExp(`/leagues/join/${joinCode}$`), { timeout: 20_000 });
  await expect(ownerPage.getByText("8 teams still unowned", { exact: false })).toBeVisible();
  await ownerPage.screenshot({ path: `${screenshots}/12-invited-new-user-returned-to-invite.png`, fullPage: true });

  // The restored invitation must claim an unowned team and land directly in its agent editor.
  await expect(ownerPage.getByText("8 teams still unowned", { exact: false })).toBeVisible();
  await expect(ownerPage.getByRole("button", { name: new RegExp(`Account: ${owner.name}`) })).toBeVisible();
  await ownerPage.screenshot({ path: `${screenshots}/13-signed-in-invite-ready.png`, fullPage: true });
  await ownerPage.getByRole("button", { name: `Join ${leagueName}` }).click();
  await expect(ownerPage).toHaveURL(new RegExp(`/leagues/${leagueId}/teams/([^/]+)/config$`), {
    timeout: 30_000,
  });
  const teamMatch = /\/teams\/([^/]+)\/config$/.exec(ownerPage.url());
  expect(teamMatch).not.toBeNull();
  await expect(ownerPage.getByRole("heading", { name: "Edit agent" })).toBeVisible();
  await ownerPage.screenshot({ path: `${screenshots}/14-owner-agent-editor-after-join.png`, fullPage: true });

  // Redeeming the same invite twice must be idempotent and offer the existing league instead.
  await ownerPage.goto(invitePath);
  await expect(ownerPage.getByText("You are already in this league")).toBeVisible();
  await expect(ownerPage.getByRole("button", { name: new RegExp(`Account: ${owner.name}`) })).toBeVisible();
  await ownerPage.screenshot({ path: `${screenshots}/15-repeat-invite-member-state.png`, fullPage: true });

  // An owner may read the public league but must receive an explicit commissioner-only settings state.
  await ownerPage.goto(`/leagues/${leagueId}/settings`);
  await expect(ownerPage.getByText("403 — commissioner only")).toBeVisible();
  await expect(ownerPage.getByText("League settings are visible to the commissioner", { exact: false })).toBeVisible();
  const ownerLeagueNav = ownerPage.getByRole("navigation", { name: "League sections" });
  await expect(ownerLeagueNav).toBeVisible();
  await expect(ownerLeagueNav.getByRole("link", { name: "Settings" })).toHaveCount(0);
  await ownerPage.screenshot({ path: `${screenshots}/16-owner-settings-forbidden.png`, fullPage: true });

  const anonymousContext = await browser.newContext({ baseURL, viewport: { width: 1280, height: 800 } });
  const anonymousPage = await anonymousContext.newPage();
  anonymousPage.on("pageerror", (error) => browserErrors.push(`anonymous: ${error.message}`));

  // Anonymous visitors get the same explicit authorization boundary plus a sign-in recovery action.
  await anonymousPage.goto(`/leagues/${leagueId}/settings`);
  await expect(anonymousPage.getByText("403 — commissioner only")).toBeVisible();
  await expect(anonymousPage.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(
    anonymousPage.getByRole("button", { name: new RegExp(`League: ${leagueName}`) }),
  ).toBeVisible();
  await anonymousPage.screenshot({ path: `${screenshots}/17-anonymous-settings-forbidden.png`, fullPage: true });

  expect(browserErrors).toEqual([]);
  await anonymousContext.close();
  await ownerContext.close();
  await commissionerContext.close();
});
