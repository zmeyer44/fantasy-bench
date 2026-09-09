import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const screenshots = process.env.AUDIT_SCREENSHOTS ?? "e2e/screenshots/audit-navigation";

// Journey: sign in → open existing league → inspect competition/community pages → repeat on mobile.
test("audit competition and community navigation on desktop and mobile", async ({ page }) => {
  test.setTimeout(180_000);
  await mkdir(screenshots, { recursive: true });
  const errors: { url: string; message: string }[] = [];
  const observations: unknown[] = [];
  page.on("pageerror", (error) => errors.push({ url: page.url(), message: error.message }));

  // Use the documented demo account read-only, preserving every existing league setting.
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill("demo@fantasybench.dev");
  await page.getByLabel("Password", { exact: true }).fill("password1234");
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(page).toHaveURL(/\/leagues$/);
  await expect(page.getByRole("heading", { name: "Your leagues" })).toBeVisible();
  await page.screenshot({ path: `${screenshots}/01-leagues-desktop.png`, fullPage: true });
  const links = await page.getByRole("table").getByRole("link").evaluateAll((items) => items.map((item) => ({ text: item.textContent, href: item.getAttribute("href") })));
  expect(links.length).toBeGreaterThan(0);
  const base = links[0].href!;
  observations.push({ leagues: links, base });

  // Check meaningful loaded content and collect evidence from every primary read flow.
  for (const [device, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844]] as const) {
    await page.setViewportSize({ width, height });
    for (const [index, route] of ["", "/standings", "/matchups", "/teams", "/commons", "/threads"].entries()) {
      const response = await page.goto(`${base}${route}`);
      await expect(page.getByRole("navigation", { name: "League sections" }).last()).toBeAttached();
      await expect(page.getByRole("main")).not.toBeEmpty();
      await page.evaluate(() => document.fonts.ready);
      await expect(page.getByRole("list", { name: "Loading the board" })).toHaveCount(0);
      if (device === "mobile") {
        const activeTab = page.getByRole("navigation", { name: "League sections" }).last().locator('[aria-current="page"]');
        await expect(activeTab).toBeInViewport();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      }
      await page.screenshot({ path: `${screenshots}/${index + 2}-${device}-${route.slice(1) || "home"}.png`, fullPage: true });
      if (route === "" || device === "mobile") {
        await page.screenshot({ path: `${screenshots}/${index + 2}-${device}-${route.slice(1) || "home"}-viewport.png` });
      }
      observations.push({ device, route: page.url(), status: response?.status(), width, scrollWidth: await page.evaluate(() => document.documentElement.scrollWidth), text: await page.getByRole("main").innerText(), links: await page.getByRole("main").getByRole("link").evaluateAll((items) => items.map((item) => ({ text: item.textContent, href: item.getAttribute("href") }))) });
    }
  }
  await writeFile(`${screenshots}/observations.json`, JSON.stringify({ observations, errors }, null, 2));
  expect(errors).toEqual([]);
});

// Journey: activity first page → older events beyond the former 100-event cap.
test("audit activity pagination beyond one hundred events", async ({ page }) => {
  const base = process.env.AUDIT_LEAGUE_PATH ?? "/leagues/m577b26pyjz8m5w86fxbpkdf418e1mah";
  await page.goto(base);
  const feed = page.getByRole("region", { name: "League activity" });
  const rows = feed.getByRole("listitem");
  await expect(rows).toHaveCount(40);
  await feed.getByRole("button", { name: "Show more", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${screenshots}/14-activity-40-events.png` });
  // The next button must continue to reveal previously hidden activity.
  await feed.getByRole("button", { name: "Show more", exact: true }).click();
  await expect(rows).toHaveCount(80);
  await feed.getByRole("button", { name: "Show more", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${screenshots}/15-activity-80-events.png` });
  await feed.getByRole("button", { name: "Show more", exact: true }).click();
  await expect(rows).toHaveCount(120);
  await feed.getByRole("button", { name: "Show more", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${screenshots}/16-activity-120-events.png` });
  await feed.getByRole("button", { name: "Show more", exact: true }).click();
  await expect.poll(() => rows.count(), { message: "Show more must reveal older events" }).toBeGreaterThan(120);
  await page.screenshot({ path: `${screenshots}/17-activity-older-history.png` });
  const more = feed.getByRole("button", { name: "Show more", exact: true });
  for (let pageNo = 0; pageNo < 10 && await more.count(); pageNo += 1) {
    const previousCount = await rows.count();
    await more.click();
    await expect.poll(() => rows.count()).toBeGreaterThan(previousCount);
  }
  await expect(more).toHaveCount(0);
  await rows.last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${screenshots}/18-activity-history-end.png` });
});

// Journey: public matchup list → detailed lineup → another week → filtered forum → post → invalid bookmark.
test("audit public competition details, filters, and invalid bookmarks", async ({ page }) => {
  test.setTimeout(120_000);
  await mkdir(screenshots, { recursive: true });
  const base = process.env.AUDIT_LEAGUE_PATH ?? "/leagues/m577b26pyjz8m5w86fxbpkdf418e1mah";
  const observations: unknown[] = [];
  const errors: { url: string; message: string }[] = [];
  page.on("pageerror", (error) => errors.push({ url: page.url(), message: error.message }));

  // A public spectator should be able to drill into a matchup without an account.
  await page.goto(`${base}/matchups/1`);
  const card = page.getByRole("main").getByRole("link", { name: /The Zero Shots/ });
  await expect(card).toBeVisible();
  observations.push({ state: "matchup-card", text: await card.innerText() });
  await card.click();
  await expect(page.getByRole("region", { name: "Matchup scoreboard" })).toBeVisible();
  await page.screenshot({ path: `${screenshots}/08-public-matchup-desktop.png`, fullPage: true });
  observations.push({ state: "matchup-detail", text: await page.getByRole("main").innerText() });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${screenshots}/09-public-matchup-mobile.png`, fullPage: true });

  // Week selection must navigate and retain a consistent selected week.
  await page.goto(`${base}/matchups/1`);
  await page.getByLabel("Week", { exact: true }).selectOption("2");
  await expect(page).toHaveURL(/\/matchups\/2$/);
  await expect(page.getByRole("heading", { name: "Week 2", exact: true })).toBeVisible();
  await expect(page.getByLabel("Week", { exact: true })).toHaveValue("2");
  await page.screenshot({ path: `${screenshots}/10-week-two-mobile.png`, fullPage: true });
  observations.push({ state: "week-two", text: await page.getByRole("main").innerText() });

  // Forum filters are shareable and spectator voting must remain disabled.
  await page.goto(`${base}/commons`);
  await expect(page.getByRole("list", { name: "Loading the board" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Upvote", exact: true }).first()).toBeDisabled();
  await page.getByRole("navigation", { name: "Sort posts" }).getByRole("link", { name: "new", exact: true }).click();
  await expect(page).toHaveURL(/sort=new/);
  await page.getByRole("navigation", { name: "Filter by flair" }).getByRole("link", { name: "analysis", exact: true }).click();
  await expect(page).toHaveURL(/sort=new&flair=analysis/);
  await expect(page.getByRole("heading", { name: "No analysis posts" })).toBeVisible();
  await expect(page.getByText("No posts match this filter.", { exact: false })).toBeVisible();
  await page.screenshot({ path: `${screenshots}/11-forum-empty-filter.png`, fullPage: true });
  await page.getByRole("link", { name: "Clear filter" }).click();
  await expect(page).toHaveURL(/sort=new$/);
  await page.getByRole("link", { name: "Week 1 Recap", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Week 1 Recap", exact: true })).toBeVisible();
  await expect(page.getByRole("main")).not.toContainText("**");
  await page.screenshot({ path: `${screenshots}/12-forum-recap.png`, fullPage: true });
  observations.push({ state: "recap", text: await page.getByRole("main").innerText() });

  // An invalid saved link should fail gracefully and provide a way back into the product.
  for (const [name, route] of [["league", "/leagues/not-a-league"], ["week", `${base}/matchups/99`], ["post", `${base}/commons/not-a-post`]]) {
    const response = await page.goto(route);
    await expect(page.getByRole("heading", { name: "We couldn’t find that page" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Your leagues", exact: true })).toBeVisible();
    await page.screenshot({ path: `${screenshots}/13-invalid-${name}.png`, fullPage: true });
    observations.push({ state: `invalid-${name}`, status: response?.status(), text: await page.getByRole("main").innerText() });
  }
  await writeFile(`${screenshots}/detail-observations.json`, JSON.stringify({ observations, errors }, null, 2));
  expect(errors).toEqual([]);
});
