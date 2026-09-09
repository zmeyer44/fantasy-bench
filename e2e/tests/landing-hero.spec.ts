import { expect, test } from "@playwright/test";

const screenshots = "e2e/screenshots/landing-hero";

test("landing hero remains readable and navigable across screen sizes", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  // Match the supplied desktop composition before testing narrower layouts.
  for (const [name, width, height] of [
    ["desktop-reference", 1672, 941],
    ["laptop", 1280, 800],
    ["tablet-landscape", 1024, 768],
    ["tablet-portrait", 768, 1024],
    ["mobile", 390, 844],
    ["small-mobile", 320, 740],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
    const hero = page.getByRole("region", { name: "Coach the Machine." });
    await expect(hero.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Get started" })).toBeVisible();
    const helmet = hero.locator("img");
    await expect(helmet).toHaveJSProperty("complete", true);
    await expect(helmet).not.toHaveJSProperty("naturalWidth", 0);
    await expect(hero.getByRole("link", { name: "Join a league" })).toBeVisible();
    expect.soft(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${name}: page should fit viewport`).toBe(true);
    // Verify important content fits horizontally, even if a clipping ancestor masks overflow.
    for (const item of [hero.getByRole("heading"), hero.getByRole("link", { name: "Join a league" })]) {
      const box = await item.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    }
    await page.screenshot({ path: `${screenshots}/${name}.png`, fullPage: true });
    await page.screenshot({ path: `${screenshots}/${name}-hero.png`, fullPage: true, clip: { x: 0, y: 0, width, height: Math.ceil((await hero.boundingBox())!.y + (await hero.boundingBox())!.height) } });
  }

  // The mobile menu must expose the same destinations and dismiss on selection.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open menu" }).click();
  const menu = page.getByRole("dialog");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("link", { name: "Leagues", exact: true })).toHaveAttribute("href", "/leagues");
  await menu.evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)));
  await page.screenshot({ path: `${screenshots}/mobile-menu.png` });
  await menu.getByRole("link", { name: "Leagues" }).click();
  await expect(menu).not.toBeVisible();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("button", { name: "Log in", exact: true })).toBeVisible();
  await page.screenshot({ path: `${screenshots}/mobile-leagues-login.png` });

  // The desktop Docs link still leads to the explanation on the landing page.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Docs", exact: true }).click();
  await expect(page).toHaveURL(/#how-it-works$/);
  await expect(page.getByRole("heading", { name: "How it works.", exact: true })).toBeInViewport();
  await page.screenshot({ path: `${screenshots}/docs-section.png` });

  // The main conversion action retains the application's real login redirect.
  await page.goto("/");
  await page.getByRole("link", { name: "Join a league", exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("button", { name: /log in|sign in/i })).toBeVisible();
  await page.screenshot({ path: `${screenshots}/join-login.png` });
  expect(errors).toEqual([]);
});
