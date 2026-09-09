import { expect, test } from "@playwright/test";

const screenshots = "e2e/screenshots/reaudit-onboarding";

test("commissioner league and team edits persist while private role boundaries remain live", async ({
  browser,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  test.setTimeout(180_000);
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const owner = {
    name: `Reaudit Assigned ${stamp.slice(-6)}`,
    email: `reaud-assigned-${stamp}@example.test`,
    password: `Reaudit-Assigned-${stamp}!`,
  };
  const commissioner = {
    name: `Reaudit Commissioner ${stamp.slice(-6)}`,
    email: `reaud-commissioner-${stamp}@example.test`,
    password: `Reaudit-Commissioner-${stamp}!`,
  };
  const replacement = {
    name: `Reaudit Replacement ${stamp.slice(-6)}`,
    email: `reaud-replacement-${stamp}@example.test`,
    password: `Reaudit-Replacement-${stamp}!`,
  };
  const errors: string[] = [];

  const ownerContext = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  const ownerPage = await ownerContext.newPage();
  ownerPage.on("pageerror", (error) => errors.push(`owner: ${error.message}`));

  // A real account must exist before the commissioner can assign it by email.
  await ownerPage.goto("/signup");
  await ownerPage.getByLabel("Name").fill(owner.name);
  await ownerPage.getByLabel("Email").fill(owner.email);
  await ownerPage.getByLabel("Password").fill(owner.password);
  await ownerPage.getByRole("button", { name: "Create account" }).click();
  await expect(ownerPage).toHaveURL(/\/leagues$/, { timeout: 20_000 });

  const replacementContext = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  const replacementPage = await replacementContext.newPage();
  replacementPage.on("pageerror", (error) => errors.push(`replacement: ${error.message}`));
  await replacementPage.goto("/signup");
  await replacementPage.getByLabel("Name").fill(replacement.name);
  await replacementPage.getByLabel("Email").fill(replacement.email);
  await replacementPage.getByLabel("Password").fill(replacement.password);
  await replacementPage.getByRole("button", { name: "Create account" }).click();
  await expect(replacementPage).toHaveURL(/\/leagues$/, { timeout: 20_000 });

  const commissionerContext = await browser.newContext({
    baseURL,
    viewport: { width: 1280, height: 900 },
  });
  const commissionerPage = await commissionerContext.newPage();
  commissionerPage.on("pageerror", (error) => errors.push(`commissioner: ${error.message}`));

  // A fresh private league isolates all management mutations from shared fixtures.
  await commissionerPage.goto("/signup");
  await commissionerPage.getByLabel("Name").fill(commissioner.name);
  await commissionerPage.getByLabel("Email").fill(commissioner.email);
  await commissionerPage.getByLabel("Password").fill(commissioner.password);
  await commissionerPage.getByRole("button", { name: "Create account" }).click();
  await expect(commissionerPage).toHaveURL(/\/leagues$/, { timeout: 20_000 });
  const initialLeagueName = `Reaudit Private ${stamp}`;
  await commissionerPage.getByLabel("League name").fill(initialLeagueName);
  await commissionerPage.getByLabel("Teams").selectOption("8");
  await commissionerPage.getByRole("button", { name: "Create league" }).click();
  await expect(commissionerPage).toHaveURL(/\/leagues\/[^/]+$/, { timeout: 30_000 });
  const leagueId = commissionerPage.url().split("/").pop()!;
  await commissionerPage.goto(`/leagues/${leagueId}/settings`);

  // League identity, privacy, and draft format must save together and survive a hard reload.
  const renamedLeague = `Reaudit Locked ${stamp}`;
  await commissionerPage.getByLabel("League name").fill(renamedLeague);
  await commissionerPage.getByRole("switch", { name: "Public league" }).click();
  await commissionerPage.getByLabel("Draft format").selectOption("auction");
  await commissionerPage.getByRole("button", { name: "Save" }).click();
  await expect(commissionerPage.getByText("Saved.", { exact: true })).toBeVisible();
  await commissionerPage.screenshot({
    path: `${screenshots}/league-01-private-settings-saved.png`,
    fullPage: true,
  });
  await commissionerPage.reload();
  await expect(commissionerPage.getByLabel("League name")).toHaveValue(renamedLeague);
  await expect(commissionerPage.getByRole("switch", { name: "Public league" })).not.toBeChecked();
  await expect(commissionerPage.getByLabel("Draft format")).toHaveValue("auction");

  // Settings must review its live saved format, roster, and model assignments before starting.
  await commissionerPage.getByRole("button", { name: "Review and start" }).click();
  const startReview = commissionerPage.getByRole("dialog");
  await expect(startReview.getByRole("heading", { name: "Review and start auction draft" })).toBeVisible();
  await expect(startReview.getByText("15 per team · 120 total")).toBeVisible();
  await expect(startReview.getByText("openai/gpt-5.6-terra × 8")).toBeVisible();
  await commissionerPage.screenshot({
    path: `${screenshots}/league-01b-settings-start-review.png`,
    fullPage: true,
  });
  await startReview.getByRole("button", { name: "Cancel" }).click();
  await expect(startReview).toHaveCount(0);

  // Team rename and case-insensitive padded owner assignment must persist as one atomic row state.
  await commissionerPage.getByRole("tab", { name: "Teams" }).click();
  const originalName = await commissionerPage.getByRole("table").getByRole("row").nth(1).getByRole("textbox").nth(0).inputValue();
  const teamName = `Reaudit Robots ${stamp.slice(-6)}`;
  const row = commissionerPage.getByRole("table").getByRole("row").filter({ has: commissionerPage.getByLabel(`${originalName} name`) });
  await row.getByLabel(`${originalName} name`).fill(teamName);
  await row.getByLabel(`${originalName} abbreviation`).fill("RQA");
  await row.getByRole("button", { name: "Rename" }).click();
  await expect(commissionerPage.getByText("Saved.", { exact: true })).toBeVisible();
  await commissionerPage.getByLabel(new RegExp(`Assign an owner to ${teamName} by email`)).fill(`  ${owner.email.toUpperCase()}  `);
  await commissionerPage.getByRole("button", { name: "Assign" }).first().click();
  await expect(commissionerPage.getByText(owner.name, { exact: true })).toBeVisible({ timeout: 20_000 });
  await commissionerPage.screenshot({
    path: `${screenshots}/league-02-team-renamed-owner-assigned.png`,
    fullPage: true,
  });
  await commissionerPage.reload();
  await commissionerPage.getByRole("tab", { name: "Teams" }).click();
  await expect(commissionerPage.getByLabel(`${teamName} name`)).toHaveValue(teamName);
  await expect(commissionerPage.getByLabel(`${teamName} abbreviation`)).toHaveValue("RQA");
  await expect(commissionerPage.getByText(owner.name, { exact: true })).toBeVisible();

  // The assigned owner should gain league membership reactively without signing in again.
  await ownerPage.reload();
  await expect(ownerPage.getByRole("link", { name: renamedLeague })).toBeVisible({ timeout: 20_000 });
  await ownerPage.getByRole("link", { name: renamedLeague }).click();
  await expect(ownerPage.getByRole("button", { name: new RegExp(`League: ${renamedLeague}`) })).toBeVisible();
  const myTeamHref = await ownerPage.getByRole("link", { name: "My Team" }).getAttribute("href");
  expect(myTeamHref).toMatch(new RegExp(`^/leagues/${leagueId}/teams/[^/]+$`));
  await expect(ownerPage.getByRole("navigation", { name: "League sections" }).getByRole("link", { name: "Settings" })).toHaveCount(0);
  await ownerPage.goto(`/leagues/${leagueId}/settings`);
  await expect(ownerPage.getByText("403 — commissioner only")).toBeVisible();
  expect(await ownerPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await ownerPage.screenshot({
    path: `${screenshots}/league-03-mobile-owner-private-boundary.png`,
    fullPage: true,
  });

  // Reassignment must revoke old owner controls and grant the replacement account fresh controls.
  await commissionerPage.goto(`/leagues/${leagueId}/settings`);
  await commissionerPage.getByRole("tab", { name: "Teams" }).click();
  const managedRow = commissionerPage.getByRole("table").getByRole("row").filter({
    has: commissionerPage.getByLabel(`${teamName} name`),
  });
  await managedRow.getByRole("button", { name: "Unassign" }).click();
  await expect(managedRow.getByText("Unowned")).toBeVisible();
  await managedRow.getByLabel(new RegExp(`Assign an owner to ${teamName} by email`)).fill(replacement.email);
  await managedRow.getByRole("button", { name: "Assign" }).click();
  await expect(managedRow.getByText(replacement.name, { exact: true })).toBeVisible();

  await ownerPage.goto(`${myTeamHref}/config`);
  await expect(ownerPage.getByRole("heading", { name: "Edit agent" })).toBeVisible();
  await expect(ownerPage.getByRole("heading", { name: "Under wraps" })).toBeVisible();
  await expect(ownerPage.getByRole("button", { name: "Save changes" })).toHaveCount(0);
  await ownerPage.screenshot({ path: `${screenshots}/league-04-old-owner-controls-revoked.png`, fullPage: true });
  await replacementPage.reload();
  await expect(replacementPage.getByRole("link", { name: renamedLeague })).toBeVisible({ timeout: 20_000 });
  await replacementPage.getByRole("link", { name: renamedLeague }).click();
  await replacementPage.getByRole("link", { name: "My Team" }).click();
  await replacementPage.getByRole("button", { name: "Edit agent" }).click();
  await expect(replacementPage.getByRole("heading", { name: "Edit agent" })).toBeVisible();
  await expect(replacementPage.getByText(/only its owner \(or the commissioner\) can change it/)).toHaveCount(0);
  await replacementPage.screenshot({ path: `${screenshots}/league-05-new-owner-controls-granted.png`, fullPage: true });

  // A signed-out visitor must not learn private league content from its direct URL.
  const anonymousContext = await browser.newContext({ baseURL, viewport: { width: 320, height: 740 } });
  const anonymousPage = await anonymousContext.newPage();
  anonymousPage.on("pageerror", (error) => errors.push(`anonymous: ${error.message}`));
  await anonymousPage.goto(`/leagues/${leagueId}`);
  await expect(anonymousPage.getByRole("heading", { name: "We couldn’t find that page" })).toBeVisible();
  await expect(anonymousPage.getByText(renamedLeague, { exact: true })).toHaveCount(0);
  expect(await anonymousPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await anonymousPage.screenshot({
    path: `${screenshots}/league-06-mobile-private-league-unavailable.png`,
    fullPage: true,
  });

  // Next's development performance instrumentation can report a negative timestamp on not-found.
  expect(errors.filter((message) => !message.includes("cannot have a negative time stamp"))).toEqual([]);
  await anonymousContext.close();
  await replacementContext.close();
  await commissionerContext.close();
  await ownerContext.close();
});
