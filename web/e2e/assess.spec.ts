import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const sampleExport = join(
  root,
  "vendor/scubagear/PowerShell/ScubaGear/Sample-Reports/ProviderSettingsExport.json",
);

/** CISA's own sample export, minus the byte order mark their file carries. */
const sample = () => Buffer.from(readFileSync(sampleExport, "utf8").replace(/^﻿/, ""), "utf8");

test("evaluates a settings export in the browser and renders a report", async ({ page }) => {
  const outbound: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.host !== "127.0.0.1:4178") outbound.push(request.url());
  });

  await page.goto("/");
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
  await page.goto("/");
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
  await page.goto("/");
  await page.setInputFiles("#settings-file", { name: "export.json", mimeType: "application/json", buffer: sample() });
  await expect(page.getByRole("heading", { name: /^Assessment:/ })).toBeVisible();

  page.on("dialog", (dialog) => dialog.accept());
  await page.click("#wipe");

  await expect(page.getByRole("heading", { name: /^Assessment:/ })).toHaveCount(0);
  await expect(page.locator("#status")).toContainText("Nothing collected");
});

test("says so when the file is not a settings export", async ({ page }) => {
  await page.goto("/");
  await page.setInputFiles("#settings-file", {
    name: "notes.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"hello":"world"}', "utf8"),
  });
  await expect(page.locator("#log")).toContainText("does not look like a ScubaGear or ScubaGoggles settings export");
});
