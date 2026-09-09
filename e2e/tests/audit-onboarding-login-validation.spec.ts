import { expect, test } from "@playwright/test";

const screenshots = "e2e/screenshots/audit-onboarding";

test("password recovery renders a complete form and preserves only a safe return path", async ({ page }) => {
  await page.goto("/forgot-password?next=%2Fleagues%2Fjoin%2FABCD2345");
  await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByRole("button", { name: "Email reset code" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to log in" })).toHaveAttribute(
    "href",
    "/login?next=%2Fleagues%2Fjoin%2FABCD2345",
  );
  await page.screenshot({ path: `${screenshots}/18a-password-recovery.png`, fullPage: true });

  await page.getByLabel("Email").fill(`unknown-recovery-${Date.now()}@example.test`);
  await page.getByRole("button", { name: "Email reset code" }).click();
  await expect(
    page.getByText(
      "We could not send a reset email. Delivery may be unavailable; please try again later.",
      { exact: true },
    ),
  ).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(250);
  await expect(
    page.getByText(
      "We could not send a reset email. Delivery may be unavailable; please try again later.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Email reset code" })).toBeVisible();
  await page.screenshot({ path: `${screenshots}/18b-recovery-delivery-unavailable.png`, fullPage: true });

  await page.goto("/forgot-password?next=https%3A%2F%2Fexample.com%2F");
  await expect(page.getByRole("link", { name: "Back to log in" })).toHaveAttribute(
    "href",
    "/login?next=%2Fleagues",
  );
});

test("password login reports failure, restores a session, and supports the explicit logout route", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const account = {
    name: `Login QA ${stamp.slice(-6)}`,
    email: `qa-onboarding-login-${stamp}@example.test`,
    password: `QA-Login-${stamp}!`,
  };
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  // A disposable account makes the successful password-login result deterministic.
  await page.goto("/signup");
  await page.getByLabel("Name").fill(account.name);
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/leagues$/, { timeout: 20_000 });
  await page.getByRole("button", { name: new RegExp(`Account: ${account.name}`) }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL("/");

  // Bad credentials must keep the visitor on the form and explain a recoverable next step.
  await page.goto("/login?next=%2Fleagues");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(`${account.password}-wrong`);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(
    page.getByText("Could not sign in. Check the email and password and try again.", { exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/login\?next=%2Fleagues$/);
  await expect(page.getByRole("link", { name: "Forgot password?" })).toHaveAttribute(
    "href",
    "/forgot-password?next=%2Fleagues",
  );
  await page.screenshot({ path: `${screenshots}/18-invalid-password-feedback.png`, fullPage: true });

  // Recovery must be a real route and keep the protected destination through its return link.
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(page).toHaveURL(/\/forgot-password\?next=%2Fleagues$/);
  await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to log in" })).toHaveAttribute(
    "href",
    "/login?next=%2Fleagues",
  );
  await page.getByLabel("Email").fill(account.email);
  await page.getByRole("button", { name: "Email reset code" }).click();
  await expect(
    page.getByText(
      "We could not send a reset email. Delivery may be unavailable; please try again later.",
      { exact: true },
    ),
  ).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(250);
  await expect(
    page.getByText(
      "We could not send a reset email. Delivery may be unavailable; please try again later.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.screenshot({ path: `${screenshots}/18c-known-recovery-delivery-unavailable.png`, fullPage: true });
  await page.getByRole("link", { name: "Back to log in" }).click();
  await expect(page).toHaveURL(/\/login\?next=%2Fleagues$/);
  await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();

  // Correct credentials must honor the protected destination and restore account chrome.
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/leagues$/, { timeout: 20_000 });
  await expect(page.getByRole("button", { name: new RegExp(`Account: ${account.name}`) })).toBeVisible();
  await page.screenshot({ path: `${screenshots}/19-password-login-restored.png`, fullPage: true });

  // The dedicated logout page must explain the effect before revoking the current browser session.
  await page.goto("/logout");
  await expect(page.getByRole("heading", { name: "Log out" })).toBeVisible();
  await expect(page.getByText("Logging out only ends this browser session.", { exact: false })).toBeVisible();
  await page.screenshot({ path: `${screenshots}/20-explicit-logout-page.png`, fullPage: true });
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL("/");
  await page.goto("/leagues");
  await expect(page).toHaveURL(/\/login\?next=%2Fleagues$/);

  // A duplicate email must never turn the Create account action into an implicit login.
  await page.goto("/signup");
  await page.getByLabel("Name").fill(account.name);
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(`${account.password}-different`);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(
    page.getByText(
      "An account with that email already exists. Log in or reset its password.",
      { exact: true },
    ),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/signup$/);
  await page.screenshot({ path: `${screenshots}/21-duplicate-signup-feedback.png`, fullPage: true });

  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("An account with that email already exists.", { exact: false })).toBeVisible();
  await expect(page).toHaveURL(/\/signup$/);

  // An attacker-controlled return value must fall back to the league console after login.
  await page.goto("/login?next=https%3A%2F%2Fexample.com%2F");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/leagues$/, { timeout: 20_000 });

  expect(pageErrors).toEqual([]);
});
