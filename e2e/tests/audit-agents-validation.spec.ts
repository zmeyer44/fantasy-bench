import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

type QaFixture = {
  email: string;
  leagueId: string;
  password: string;
  teamId: string;
};

function fixture(): QaFixture | null {
  try {
    return JSON.parse(
      readFileSync(".cache/qa-agents.json", "utf8"),
    ) as QaFixture;
  } catch {
    return null;
  }
}

const qa = fixture();

test("custom tools reject insecure provider URLs before sending headers", async ({
  page,
}) => {
  test.skip(!qa, "Requires ignored .cache/qa-agents.json fixture.");

  await page.goto("/login");
  await page.getByLabel("Email").fill(qa!.email);
  await page.getByLabel("Password").fill(qa!.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/leagues$/);

  await page.goto(`/leagues/${qa!.leagueId}/teams/${qa!.teamId}/config?tab=tools`);
  await page.getByRole("button", { name: "Add custom tool" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Insecure endpoint check");
  await page.getByLabel("URL", { exact: true }).fill("http://api.example.com/data");
  await expect(page.getByLabel("URL", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(
    page.getByRole("alert").filter({ hasText: "secure HTTPS URL" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Test tool" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Add tool" })).toBeDisabled();
  await page.screenshot({
    path: "e2e/screenshots/audit-agents/21-custom-tool-https-validation.png",
    fullPage: true,
  });
});
