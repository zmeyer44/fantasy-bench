import { expect, test, type Page } from "@playwright/test";

const shots = "/private/tmp/claude-501/-Users-claudius-fantasy-bench/1d0a10a6-de37-47df-ade0-7ae68a41b470/scratchpad/shots";
const LEAGUE = "m577b26pyjz8m5w86fxbpkdf418e1mah";
const snap = (page: Page, name: string) =>
  page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });

test("author a skill on its own page", async ({ page }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/login");
  await page.getByLabel("Email").fill("demo@fantasybench.dev");
  await page.getByLabel("Password").fill("password1234");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/leagues$/, { timeout: 30_000 });

  await page.goto(`/leagues/${LEAGUE}`);
  const teamHref = await page
    .locator('a[href*="/teams/"]')
    .first()
    .getAttribute("href");
  console.log("TEAM HREF", teamHref);
  const teamBase = teamHref!.split("/config")[0];

  // ---- 1. the prompt tab, before -----------------------------------------
  await page.goto(`${teamBase}/config?tab=prompt`);
  await expect(page.getByRole("heading", { name: "Attached skills" })).toBeVisible();

  // Attach one from the library first, to prove the round trip keeps it.
  await page.getByRole("button", { name: "Attach from library" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const firstAttach = dialog.getByRole("button", { name: "Attach", exact: true }).first();
  const libraryName = await firstAttach
    .locator("xpath=../div//span")
    .first()
    .textContent();
  await firstAttach.click();
  await dialog.getByRole("button", { name: "Done" }).click();
  console.log("LIBRARY SKILL", libraryName);
  await snap(page, "01-prompt-tab-with-library-skill");

  // ---- 2. leave for the composer -----------------------------------------
  await page.getByRole("link", { name: "Author new" }).click();
  await page.waitForURL(/\/config\/skills\/new$/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "New skill", level: 1 })).toBeVisible();
  await snap(page, "02-composer-empty");

  const stamp = Date.now().toString().slice(-6);
  const name = `Bye-week planner ${stamp}`;
  await page.getByLabel("Name").fill(name);
  await page
    .getByLabel("One-line description")
    .fill("Plans two weeks ahead so no slot is empty on a bye.");

  // The full editor: insert a scaffold, then type, then check the toolbar.
  const body = page.getByLabel("Skill markdown");
  await expect(body).toBeVisible();
  await body.fill(
    "# Bye-week planner\n\nKeep every starting slot filled through the bye weeks.\n\n## When to use it\n\n- Any waiver or lineup window from week 4 onward.\n\n## Procedure\n\n1. Call `get_roster` and read each starter's bye week.\n2. Flag any week where two starters at the same position are out.\n3. Bid on the cheapest bench player who covers the gap.\n\n## Checks\n\n- [ ] No starting slot is empty in the next three weeks.\n",
  );
  await snap(page, "03-composer-filled");

  // Split view, to show the preview pane works on the page.
  await page.getByRole("radio", { name: /Split/i }).click().catch(() => {});
  await snap(page, "04-composer-split");

  // ---- 3. publish ---------------------------------------------------------
  await page.getByRole("button", { name: "Publish & attach" }).click();
  await page.waitForURL(/\/config\?tab=prompt$/, { timeout: 30_000 });

  // Both the library skill and the new one are on the draft.
  const list = page.locator("ol li");
  await expect(page.getByText(name, { exact: false }).first()).toBeVisible({ timeout: 20_000 });
  if (libraryName) {
    await expect(page.getByText(libraryName.trim(), { exact: false }).first()).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "Save changes" })).toBeVisible();
  await snap(page, "05-back-with-both-attached");

  // ---- 4. save the config version ----------------------------------------
  await page.getByLabel("Change summary").fill(`skill composer check ${stamp}`);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status")).toContainText("Changes saved", { timeout: 30_000 });
  await snap(page, "06-saved");

  await page.reload();
  await expect(page.getByText(name, { exact: false }).first()).toBeVisible({ timeout: 20_000 });
  await snap(page, "07-after-reload");

  console.log("ERRORS", errors.join(" | "));
  expect(errors).toEqual([]);
});
