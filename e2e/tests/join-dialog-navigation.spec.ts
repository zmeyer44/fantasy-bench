import { expect, test } from "@playwright/test";

test("join dialog follows same-page navigation and can reopen after closing", async ({ page }) => {
  const stamp = Date.now();
  const shots = "e2e/screenshots/join-dialog-navigation";
  // A fresh account has no memberships and exposes the nav's Join a league link.
  await page.goto("/signup");
  await page.getByLabel("Name", { exact: true }).fill("Join navigation check");
  await page.getByLabel("Email", { exact: true }).fill(`join-navigation-${stamp}@example.test`);
  await page.getByLabel("Password", { exact: true }).fill(`Join-navigation-${stamp}!`);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page).toHaveURL(/\/leagues$/);
  await expect(page.getByRole("heading", { name: "Your leagues" })).toBeVisible();
  await page.screenshot({ path: `${shots}/01-leagues.png`, fullPage: true });

  // Query-only navigation must open the already-mounted console's dialog.
  const navJoin = page.getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Join a league", exact: true });
  await navJoin.click();
  const dialog = page.getByRole("dialog", { name: "Join a league", exact: true });
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: `${shots}/02-join-open.png`, fullPage: true });

  // Closing clears only dialog intent, preserving unrelated query and fragment data.
  await page.goto("/leagues?join=1&source=check#invite");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page).toHaveURL(/\/leagues\?source=check#invite$/);
  await page.screenshot({ path: `${shots}/03-join-closed.png`, fullPage: true });

  // The same nav action must work again without a hard reload.
  await navJoin.click();
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: `${shots}/04-join-reopened.png`, fullPage: true });
});
