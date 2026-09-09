import { expect, test } from "@playwright/test";

const screenshots = "e2e/screenshots/reaudit-onboarding";

test("account normalization, duplicate signup, safe returns, and logout remain coherent", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const localPart = `reaud-onboarding-${stamp}`;
  const canonicalEmail = `${localPart}@example.test`;
  const submittedEmail = `  ${localPart.toUpperCase()}@EXAMPLE.TEST  `;
  const account = {
    name: `Reaudit Owner ${stamp.slice(-6)}`,
    password: `Reaudit-Auth-${stamp}!`,
  };
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  // Mixed-case, padded addresses must create one canonical account rather than an unreachable identity.
  await page.goto("/signup?next=%2Fleagues%3Fsource%3Dreaudit%23join-league");
  await page.getByLabel("Name").fill(account.name);
  await page.getByLabel("Email").fill(submittedEmail);
  await page.getByLabel("Password").fill(account.password);
  await page.screenshot({ path: `${screenshots}/auth-01-padded-mixed-case-signup.png`, fullPage: true });
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/leagues\?source=reaudit#join-league$/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Your leagues" })).toBeVisible();
  await page.screenshot({ path: `${screenshots}/auth-02-safe-query-fragment-return.png`, fullPage: true });

  // Logout must revoke this browser's access to a protected console immediately.
  await page.getByRole("button", { name: new RegExp(`Account: ${account.name}`) }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL("/");
  await page.goto("/leagues");
  await expect(page).toHaveURL(/\/login\?next=%2Fleagues$/);
  await page.screenshot({ path: `${screenshots}/auth-03-logout-route-guard.png`, fullPage: true });

  // Login must resolve the same account when casing and surrounding whitespace change again.
  await page.getByLabel("Email").fill(` ${canonicalEmail.toUpperCase()} `);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/leagues$/, { timeout: 20_000 });
  await expect(page.getByRole("button", { name: new RegExp(`Account: ${account.name}`) })).toBeVisible();
  await page.screenshot({ path: `${screenshots}/auth-04-normalized-login-restored.png`, fullPage: true });

  // An equivalent email must be rejected as an existing account even with the correct password.
  await page.goto("/signup");
  await page.getByLabel("Name").fill("Duplicate identity");
  await page.getByLabel("Email").fill(` ${canonicalEmail.toUpperCase()} `);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(
    page.getByText("An account with that email already exists. Log in or reset its password.", {
      exact: true,
    }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/signup$/);
  await page.screenshot({ path: `${screenshots}/auth-05-case-insensitive-duplicate.png`, fullPage: true });

  // Protocol-relative and backslash return values must stay on the local league console.
  for (const [label, unsafeNext] of [
    ["protocol-relative", "//example.com/steal"],
    ["backslash", "/\\example.com/steal"],
  ] as const) {
    await page.goto(`/login?next=${encodeURIComponent(unsafeNext)}`);
    await page.getByLabel("Email").fill(canonicalEmail);
    await page.getByLabel("Password").fill(account.password);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL(/\/leagues$/, { timeout: 20_000 });
    await page.screenshot({ path: `${screenshots}/auth-06-${label}-return-rejected.png`, fullPage: true });
  }

  expect(pageErrors).toEqual([]);
});
