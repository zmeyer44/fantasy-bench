import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";

const screenshots = process.env.AUDIT_SCREENSHOTS ?? "e2e/screenshots/audit-community";
const fixturePath = ".cache/audit-community-fixture.json";

// Journey: QA commissioner logs in → votes and reverses vote → hides an open spectator post → restores it.
test("audit forum votes, persistence, and live moderation", async ({ page, browser }) => {
  test.skip(!existsSync(fixturePath), "Requires the disposable transaction QA fixture and scripted weekly recap.");
  test.setTimeout(90_000);
  await mkdir(screenshots, { recursive: true });
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  const base = `/leagues/${fixture.leagueId}`;
  const errors: unknown[] = [];
  page.on("pageerror", (error) => errors.push({ viewer: "commissioner", message: error.message }));

  // Use isolated QA credentials; existing demo posts and votes remain untouched.
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(fixture.email);
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(page).toHaveURL(/\/leagues$/);
  await page.goto(`${base}/commons`);
  await page.getByRole("link", { name: "Awards", exact: true }).click();
  const post = page.getByRole("article");
  await expect(post.getByRole("heading", { name: "Awards", exact: true })).toBeVisible();
  const staleUnhide = page.getByRole("button", { name: "Unhide", exact: true });
  if (await staleUnhide.isVisible()) {
    await staleUnhide.click();
    await expect(page.getByRole("button", { name: "Hide", exact: true })).toBeVisible();
  }
  await page.screenshot({ path: `${screenshots}/01-owner-post.png`, fullPage: true });

  // Votes must persist through reload, and toggling the same direction must remove the vote.
  await post.getByRole("button", { name: "Upvote", exact: true }).click();
  await expect(post.getByRole("button", { name: "Upvote", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(post.getByRole("button", { name: "Upvote", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(post.getByText("1", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${screenshots}/02-upvote-persisted.png`, fullPage: true });
  await post.getByRole("button", { name: "Downvote", exact: true }).click();
  await expect(post.getByText("-1", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${screenshots}/03-downvote.png`, fullPage: true });
  await post.getByRole("button", { name: "Downvote", exact: true }).click();
  await expect(post.getByText("0", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${screenshots}/04-vote-cleared.png`, fullPage: true });

  // A spectator viewing a post when it is hidden should receive a recoverable unavailable state.
  const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const guest = await guestContext.newPage();
  guest.on("pageerror", (error) => errors.push({ viewer: "spectator", message: error.message }));
  const postUrl = page.url();
  await guest.goto(postUrl);
  await expect(guest.getByRole("heading", { name: "Awards", exact: true })).toBeVisible();
  await expect(guest.getByRole("button", { name: "Upvote", exact: true })).toBeDisabled();
  let postHidden = false;
  let guestHiddenText = "";
  try {
    await page.getByRole("button", { name: "Hide", exact: true }).click();
    postHidden = true;
    await expect(page.getByRole("button", { name: "Unhide", exact: true })).toBeVisible();
    await expect(guest.getByRole("heading", { name: "Awards", exact: true })).toHaveCount(0);
    await expect(
      guest.getByRole("heading", { name: "This post is no longer available" }),
    ).toBeVisible();
    await expect(guest.getByRole("link", { name: "Back to The Commons" })).toBeVisible();
    await guest.screenshot({ path: `${screenshots}/05-spectator-post-hidden-live.png`, fullPage: true });
    await page.screenshot({ path: `${screenshots}/06-owner-hidden-post.png`, fullPage: true });
    guestHiddenText = await guest.locator("body").innerText();

    // Restoring a post must make it readable again without recreating content or votes.
    await page.getByRole("button", { name: "Unhide", exact: true }).click();
    postHidden = false;
    await expect(page.getByRole("button", { name: "Hide", exact: true })).toBeVisible();
    await expect(post.getByText("Hidden", { exact: true })).toHaveCount(0);
    await expect(
      guest.getByRole("heading", { name: "This post is no longer available" }),
    ).toHaveCount(0);
    await expect(guest.getByRole("heading", { name: "Awards", exact: true })).toBeVisible();
    await expect(
      guest.getByRole("article").getByText("0", { exact: true }),
    ).toBeVisible();
    await guest.screenshot({ path: `${screenshots}/07-spectator-restored.png`, fullPage: true });
    await writeFile(`${screenshots}/observations.json`, JSON.stringify({ guestHiddenText, errors }, null, 2));
  } finally {
    if (postHidden && await page.getByRole("button", { name: "Unhide", exact: true }).isVisible()) {
      await page.getByRole("button", { name: "Unhide", exact: true }).click();
    }
    await guestContext.close();
  }
  expect(errors).toEqual([]);
});
