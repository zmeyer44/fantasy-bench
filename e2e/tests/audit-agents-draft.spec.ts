import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

type QaFixture = {
  email: string;
  leagueId: string;
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

test("debounced context draft survives a production reload", async ({
  page,
}) => {
  test.skip(
    !fixture,
    "Create the ignored .cache/qa-agents.json QA fixture before running this audit.",
  );
  const { email, leagueId, password, runId, teamId } = fixture!;
  const marker = `QA debounced draft ${runId}`;

  await page.goto("http://localhost:3301/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/leagues$/);

  await page.goto(
    `http://localhost:3301/leagues/${leagueId}/teams/${teamId}/config`,
  );
  const editor = page.getByLabel("Agent context");
  await expect(editor).toBeEditable();
  await editor.fill(marker);

  await page.waitForFunction(
    (expected) =>
      Object.keys(window.localStorage).some((key) => {
        const value = window.localStorage.getItem(key);
        return key.startsWith("fb:draft:") && value?.includes(expected);
      }),
    marker,
    { timeout: 5_000 },
  );

  await page.reload();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "You have an unsaved draft" }),
  ).toBeVisible();
  await expect(editor).not.toHaveValue(marker);
  await page.screenshot({
    path: "e2e/screenshots/audit-agents/20-owner-draft-recovery-production.png",
    fullPage: true,
  });

  await page.getByRole("button", { name: "Restore" }).click();
  await expect(editor).toHaveValue(marker);
  await page.evaluate(() => {
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith("fb:draft:")) window.localStorage.removeItem(key);
    }
  });
});
