import { readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

const screenshots = "e2e/screenshots/audit-agents";
const demoLeagueId = "m577b26pyjz8m5w86fxbpkdf418e1mah";

type QaFixture = {
  email: string;
  leagueId: string;
  leagueName: string;
  password: string;
  runId: string;
  teamId: string;
};

function readFixture(): QaFixture | null {
  try {
    return JSON.parse(readFileSync(".cache/qa-agents.json", "utf8")) as QaFixture;
  } catch {
    return null;
  }
}

const fixture = readFixture();

async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: `${screenshots}/${name}.png`, fullPage: true });
}

test("agent customization persists and respects owner, commissioner, and spectator boundaries", async ({
  browser,
  page,
}) => {
  test.skip(!fixture, "Create the ignored .cache/qa-agents.json QA fixture before running this audit.");
  test.setTimeout(300_000);
  const {
    email,
    leagueId: expectedLeagueId,
    leagueName,
    password,
    runId,
    teamId: expectedTeamId,
  } = fixture!;
  const skillName = `QA Floor Reader ${runId}`;
  const customToolSlug = `custom_qa_weather_${runId.replace(/-/g, "_")}`;
  const contextText = `# QA strategy ${runId}\n\nPrefer projection floors and verify injuries before every decision.`;
  const noteText = `QA note ${runId}: explain any projection override.`;
  const ownerErrors: string[] = [];
  page.on("pageerror", (error) => ownerErrors.push(error.message));

  // Resume the isolated account created by this audit so retries never add throwaway leagues.
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/leagues$/);

  // Reopen the isolated public league and capture the real commissioner landing state.
  await page.getByRole("link", { name: leagueName, exact: true }).click();
  await expect(page).toHaveURL(/\/leagues\/[a-z0-9]+$/);
  const leaguePath = new URL(page.url()).pathname;
  const origin = new URL(page.url()).origin;
  const leagueId = leaguePath.split("/").at(-1)!;
  expect(leagueId).toBe(expectedLeagueId);
  await expect(page.getByText(leagueName, { exact: true }).first()).toBeVisible();
  await screenshot(page, "01-owner-league-created");

  // Reopen the configured team as commissioner and verify the earlier save persisted.
  await page.goto(`${leaguePath}/teams`);
  const teamHref = await page.getByRole("link", { name: "Team 1", exact: true }).getAttribute("href");
  expect(teamHref).toMatch(new RegExp(`^${leaguePath}/teams/`));
  await page.goto(`${teamHref}/config`);
  await expect(page.getByRole("heading", { name: "Edit agent" })).toBeVisible();
  const teamPath = new URL(page.url()).pathname.replace(/\/config$/, "");
  const teamId = teamPath.split("/").at(-1)!;
  expect(teamId).toBe(expectedTeamId);
  const editor = page.getByLabel("Agent context");
  await expect(editor).toBeEditable();
  expect(await editor.inputValue()).toContain(contextText);
  await expect(page.getByText(skillName, { exact: true }).last()).toBeVisible();
  await page.getByRole("tab", { name: "Model & harness" }).click();
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue("mock/scripted");
  await expect(page.getByLabel("Max steps")).toHaveValue("7");
  await expect(page.getByLabel("Token budget per run")).toHaveValue("12000");
  await expect(page.getByLabel("Temperature")).toHaveValue("0.4");
  await expect(page.getByRole("checkbox", { name: /Deliberate mode/ })).toBeChecked();
  await screenshot(page, "06-owner-config-persisted");

  // History and free-form comparison must expose the owner-visible immutable diff.
  await page.getByRole("link", { name: "Versions" }).click();
  await expect(page.getByRole("heading", { name: "Config history" })).toBeVisible();
  await expect(page.getByText(/\d+ versions/)).toBeVisible();
  await expect(page.getByText(`QA configured ${runId}`)).toBeVisible();
  await screenshot(page, "07-owner-version-history");
  await page.getByRole("link", { name: "Compare first ↔ latest" }).click();
  await expect(page.getByRole("heading", { name: "Compare versions" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Model & harness" })).toBeVisible();
  await expect(page.getByText("Scripted Mock")).toBeVisible();
  await expect(page.getByText(skillName, { exact: true })).toBeVisible();
  await expect(page.getByText(noteText, { exact: false })).toBeVisible();
  await screenshot(page, "08-owner-version-compare");

  // A default-tool edit creates its own version and survives a reload.
  await page.goto(`${teamPath}/config/tools/search_players`);
  await expect(page.getByRole("heading", { name: "search_players" })).toBeVisible();
  const baselineGuidance = `QA ${runId}: sort by projection and check availability.`;
  const currentGuidance = await page.getByLabel("Owner guidance").inputValue();
  const guidance = currentGuidance.endsWith("Confirm depth.")
    ? baselineGuidance
    : `${baselineGuidance} Confirm depth.`;
  await page.getByLabel("Owner guidance").fill(guidance);
  await page.getByLabel("Change summary").fill(`QA guided search ${runId}`);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Changes saved" }),
  ).toBeVisible();
  await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel("Owner guidance")).toHaveValue(guidance);
  await expect(page.getByRole("button", { name: /Account:/ })).toBeVisible();
  await screenshot(page, "09-owner-default-tool-saved");
  await page.getByRole("link", { name: "Versions" }).click();
  await expect(page.getByText(`QA guided search ${runId}`).first()).toBeVisible();

  // Reopen the custom tool created after its malformed-header rejection and successful live test.
  await page.goto(`${teamPath}/config?tab=tools`);
  await expect(page.getByText(customToolSlug, { exact: true })).toBeVisible();
  const toolSwitch = page.getByLabel(`Enable ${customToolSlug}`);
  if (await toolSwitch.isChecked()) {
    await toolSwitch.click();
    await expect(page.getByRole("status")).toContainText("disabled. Applies to the next run.");
  }
  await page.reload();
  await page.getByRole("tab", { name: /Tools/ }).click();
  await expect(page.getByLabel(`Enable ${customToolSlug}`)).not.toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await screenshot(page, "12-owner-custom-tool-mobile");

  // Commissioner budget changes must persist and flow into the owner's spend panel.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${leaguePath}/settings`);
  await page.getByRole("tab", { name: "Budgets" }).click();
  await page.getByLabel("Weekly spend cap per team (USD)").fill("0.75");
  await page.getByLabel("Weekly token cap per team").fill("50000");
  await page.getByLabel("League USD hard cap").fill("12.34");
  await page
    .getByRole("tabpanel", { name: "Budgets" })
    .getByRole("button", { name: "Save" })
    .click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  await screenshot(page, "13-commissioner-budgets-saved");
  await page.reload();
  await page.getByRole("tab", { name: "Budgets" }).click();
  await expect(page.getByLabel("Weekly spend cap per team (USD)")).toHaveValue("0.75");
  await expect(page.getByLabel("Weekly token cap per team")).toHaveValue("50000");
  await expect(page.getByLabel("League USD hard cap")).toHaveValue("12.34");
  await page.goto(`${teamPath}/config?tab=model`);
  await expect(page.getByText(/Weekly team cap: 50,000/)).toBeVisible();
  await expect(page.getByText("$0.75")).toBeVisible();
  await expect(page.getByText("$12.34")).toBeVisible();
  await screenshot(page, "14-owner-spend-reflects-budgets");

  // Anonymous spectators may read the public league but see cooling customizations as under wraps.
  const spectatorContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const spectator = await spectatorContext.newPage();
  const spectatorErrors: string[] = [];
  spectator.on("pageerror", (error) => spectatorErrors.push(error.message));
  await spectator.goto(`${origin}${teamPath}/config`);
  await expect(spectator.getByRole("heading", { name: "Edit agent" })).toBeVisible();
  await expect(spectator.getByText("Under wraps", { exact: true })).toBeVisible();
  await expect(spectator.getByRole("link", { name: /Get started/i })).toBeVisible();
  await expect(spectator.getByLabel("Agent context")).toHaveCount(0);
  await screenshot(spectator, "15-spectator-agent-under-wraps-mobile");
  expect(
    await spectator.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await spectator.goto(`${origin}${teamPath}/config/versions`);
  await expect(spectator.getByText("private until", { exact: false }).first()).toBeVisible();
  await expect(spectator.getByRole("link", { name: /Get started/i })).toBeVisible();
  await expect(spectator.getByRole("link", { name: "Compare first ↔ latest" })).toHaveCount(0);
  await screenshot(spectator, "16-spectator-versions-redacted-mobile");
  await spectator.goto(`${origin}${leaguePath}/settings`);
  await expect(spectator.getByText("403 — commissioner only", { exact: true })).toBeVisible();
  await expect(spectator.getByRole("link", { name: /Get started/i })).toBeVisible();
  await spectator.evaluate(() => window.scrollTo(0, 0));
  await screenshot(spectator, "17-spectator-settings-forbidden-mobile");

  // The seeded league supplies real read-only runs for trace search, detail, usage, and export QA.
  await spectator.setViewportSize({ width: 1440, height: 1000 });
  await spectator.goto(`${origin}/leagues/${demoLeagueId}/traces`);
  await expect(spectator.getByRole("heading", { name: "Traces" })).toBeVisible();
  await expect(spectator.getByText(/run/).first()).toBeVisible();
  await spectator.getByLabel("Search traces").fill("set_lineup");
  await spectator.getByRole("button", { name: "Search" }).click();
  await expect(spectator).toHaveURL(/q=set_lineup/);
  await expect(spectator.getByText(/Matching “set_lineup”/)).toBeVisible();
  await screenshot(spectator, "18-spectator-trace-search");
  await spectator.getByRole("link").filter({ hasText: /·/ }).last().click();
  await expect(spectator.getByRole("heading", { name: "Prompt" })).toBeVisible();
  await expect(spectator.getByRole("heading", { name: "Usage ledger" })).toBeVisible();
  await expect(spectator.getByText(/private until/i).first()).toBeVisible();
  await spectator.getByText("Owner context", { exact: true }).click();
  await expect(spectator.getByText(/owner's customisations reveal 21 days/i)).toBeVisible();
  await screenshot(spectator, "19-spectator-trace-redacted-detail");
  const exportHref = await spectator
    .getByText("Export JSON", { exact: true })
    .evaluate(
      (element) => element.closest("a")?.getAttribute("href") ?? null,
    );
  expect(exportHref).toMatch(/^\/api\/leagues\/.+\/traces\/.+\/export$/);
  const exportResponse = await spectatorContext.request.get(`${origin}${exportHref}`);
  expect(exportResponse.status()).toBe(200);
  expect(exportResponse.headers()["content-disposition"]).toContain("attachment;");
  const payload = (await exportResponse.json()) as {
    version: number;
    trace: { promptSections: Array<{ id: string; text: string }>; steps: unknown[] };
  };
  expect(payload.version).toBe(1);
  expect(payload.trace.steps.length).toBeGreaterThan(0);
  expect(payload.trace.promptSections.find((section) => section.id === "owner_context")?.text).toMatch(
    /private until/,
  );

  expect(ownerErrors).toEqual([]);
  expect(spectatorErrors).toEqual([]);
  await spectatorContext.close();

  test.info().annotations.push(
    { type: "qa-league", description: leagueId },
    { type: "qa-team", description: teamId },
    { type: "qa-user", description: email },
  );
});
