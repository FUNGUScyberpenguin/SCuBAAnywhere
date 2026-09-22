import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const sampleExport = join(
  root,
  "vendor/scubagear/PowerShell/ScubaGear/Sample-Reports/ProviderSettingsExport.json",
);

/** CISA's own sample export, minus the byte order mark their file carries. */
const sample = () => Buffer.from(readFileSync(sampleExport, "utf8").replace(/^\uFEFF/, ""), "utf8");

/**
 * The app's own URL, relative to the configured baseURL. It is "./" rather than
 * "/" so the same specs run against a root build and against a GitHub Pages
 * build served from /<repo>/.
 */
const APP = "./";

/** Every request that leaves the page's own origin and path prefix. */
function watchOutboundRequests(page: Page, baseURL: string): string[] {
  const outbound: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith(baseURL)) outbound.push(request.url());
  });
  return outbound;
}


test("evaluates a settings export in the browser and renders a report", async ({ page, baseURL }) => {
  const outbound = watchOutboundRequests(page, baseURL!);

  await page.goto(APP);
  await page.setInputFiles("#settings-file", { name: "ProviderSettingsExport.json", mimeType: "application/json", buffer: sample() });

  // The tenant name comes out of the export, not from anything typed in.
  await expect(page.getByRole("heading", { name: "Assessment: tqhjy" })).toBeVisible();

  // The sample export carries data for six of the eight Microsoft products, and
  // these are the verdict counts the OPA binary produces for it.
  await expect(page.locator(".tile").nth(0)).toContainText("62");
  await expect(page.locator(".tile").nth(1)).toContainText("15");
  await expect(page.locator(".tile").nth(4)).toContainText("0");
  await expect(page.locator(".product-table tbody tr")).toHaveCount(6);

  // Nothing about the tenant may leave the page.
  expect(outbound).toEqual([]);
});

test("keeps the settings export out of browser storage", async ({ page }) => {
  await page.goto(APP);
  await page.setInputFiles("#settings-file", { name: "export.json", mimeType: "application/json", buffer: sample() });
  await expect(page.getByRole("heading", { name: /^Assessment:/ })).toBeVisible();

  const stored = await page.evaluate(() => ({
    local: window.localStorage.length,
    session: window.sessionStorage.length,
    databases: typeof indexedDB.databases === "function" ? indexedDB.databases() : Promise.resolve([]),
  }));
  expect(stored.local).toBe(0);
  expect(stored.session).toBe(0);

  // And a write attempt is refused rather than silently succeeding.
  const refused = await page.evaluate(() => {
    try {
      window.localStorage.setItem("scuba", "leak");
      return "allowed";
    } catch {
      return "refused";
    }
  });
  expect(refused).toBe("refused");
});

test("wiping the session leaves nothing behind", async ({ page }) => {
  await page.goto(APP);
  await page.setInputFiles("#settings-file", { name: "export.json", mimeType: "application/json", buffer: sample() });
  await expect(page.getByRole("heading", { name: /^Assessment:/ })).toBeVisible();

  page.on("dialog", (dialog) => dialog.accept());
  await page.click("#wipe");

  await expect(page.getByRole("heading", { name: /^Assessment:/ })).toHaveCount(0);
  await expect(page.locator("#status")).toContainText("Nothing collected");
});

test("says so when the file is not a settings export", async ({ page }) => {
  await page.goto(APP);
  await page.setInputFiles("#settings-file", {
    name: "notes.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"hello":"world"}', "utf8"),
  });
  await expect(page.locator("#log")).toContainText("does not look like a ScubaGear or ScubaGoggles settings export");
});

/**
 * A ScubaGoggles-shaped settings export, built from the reduced policies in
 * ScubaGoggles' own fixture. It exercises the Google side of the pipeline end
 * to end: suite detection, the policy-id version suffixes, evaluation of all
 * eleven Google baselines, and the report.
 */
function googleSettings(): Buffer {
  const fixture = JSON.parse(
    readFileSync(join(root, "vendor/scubagoggles/scubagoggles/Testing/Unit/Python/data/policyapi_get_policies1.json"), "utf8"),
  ) as { results: Record<string, Record<string, unknown>> };

  const logs = Object.fromEntries(
    ["assuredcontrols", "chat", "commoncontrols", "drive", "gemini", "gmail", "meet"].map((product) => [
      `${product}_logs`,
      { items: [] },
    ]),
  );

  return Buffer.from(
    JSON.stringify({
      tenant_info: { ID: "C0123abc", domain: "example.gov", topLevelOU: "topOU" },
      policies: fixture.results,
      organizational_units: { organizationUnits: [] },
      organizational_unit_names: ["", "topOU"],
      ...logs,
      domains: ["example.gov"],
      alias_domains: [],
      spf_records: [],
      dkim_records: [],
      dmarc_records: [],
      super_admins: [],
      privileged_users: [],
      privileged_users_error: null,
      inbound_sso_assignments: [],
      inbound_sso_assignments_error: null,
      break_glass_accounts: [],
      successful_calls: [],
      unsuccessful_calls: [],
    }),
    "utf8",
  );
}

test("evaluates a Google Workspace export and names the policies correctly", async ({ page, baseURL }) => {
  const outbound = watchOutboundRequests(page, baseURL!);

  await page.goto(APP);
  await page.setInputFiles("#settings-file", {
    name: "ScubaGogglesExport.json",
    mimeType: "application/json",
    buffer: googleSettings(),
  });

  await expect(page.getByRole("heading", { name: "Assessment: topOU" })).toBeVisible();
  await expect(page.locator(".product-table tbody tr")).toHaveCount(11);

  // Without the version suffixes from the baseline, every Google policy id
  // comes back as "...vM" and matches nothing in the baseline text.
  const firstPolicy = page.locator(".policy code").first();
  await expect(firstPolicy).toHaveText(/^GWS\.[A-Z]+\.\d+\.\d+v\d+$/);
  await expect(page.locator(".policy .policy-name").first()).not.toBeEmpty();

  expect(outbound).toEqual([]);
});

test("offers the Google sign-in path", async ({ page }) => {
  await page.goto(APP);
  await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
  // With no client id configured the app says so rather than failing on click.
  await expect(page.locator("#log")).toContainText("No Google client id is configured");
});

test("shows requirement text without its Markdown markers", async ({ page }) => {
  await page.goto(APP);
  await page.setInputFiles("#settings-file", {
    name: "ScubaGogglesExport.json",
    mimeType: "application/json",
    buffer: googleSettings(),
  });
  await expect(page.getByRole("heading", { name: "Assessment: topOU" })).toBeVisible();

  // GWS.COMMONCONTROLS.6.2v1 reads "A minimum of **two** ..." upstream.
  const names = await page.locator(".policy .policy-name").allInnerTexts();
  expect(names.join(" ")).not.toContain("**");
  expect(names.some((name) => name.includes("A minimum of two"))).toBe(true);
});
