import { describe, expect, it } from "vitest";
import { checkTarget } from "../src/allowlist.js";

const allowed = (target: string) => checkTarget(target).allowed;

describe("checkTarget", () => {
  it("allows the Exchange Online admin API", () => {
    expect(allowed("https://outlook.office365.com/adminapi/beta/tenant-id/InvokeCommand")).toBe(true);
  });

  it("allows a tenant's SharePoint admin host", () => {
    expect(allowed("https://contoso-admin.sharepoint.com/_api/SPO.Tenant")).toBe(true);
    expect(allowed("https://contoso-admin.sharepoint.us/_api/SPO.Tenant")).toBe(true);
    expect(allowed("https://contoso-admin.sharepoint-mil.us/_api/SPO.Tenant")).toBe(true);
  });

  it("refuses a host that is not on the list", () => {
    expect(allowed("https://evil.example/adminapi/beta/x")).toBe(false);
    expect(checkTarget("https://evil.example/x").reason).toMatch(/allowlist/);
  });

  it("refuses a lookalike of an allowed host", () => {
    // Suffix and prefix tricks are the reason the host is matched exactly.
    expect(allowed("https://outlook.office365.com.evil.example/adminapi/x")).toBe(false);
    expect(allowed("https://evil-outlook.office365.com/adminapi/x")).toBe(false);
    expect(allowed("https://contoso-admin.sharepoint.com.evil.example/_api/SPO.Tenant")).toBe(false);
  });

  it("refuses a path outside what the collectors use", () => {
    expect(allowed("https://outlook.office365.com/owa/mail")).toBe(false);
    expect(allowed("https://contoso-admin.sharepoint.com/sites/HR/Documents")).toBe(false);
  });

  it("refuses plaintext, credentials in the URL, and odd ports", () => {
    expect(allowed("http://outlook.office365.com/adminapi/x")).toBe(false);
    expect(allowed("https://user:pass@outlook.office365.com/adminapi/x")).toBe(false);
    expect(allowed("https://outlook.office365.com:8443/adminapi/x")).toBe(false);
  });

  it("refuses something that is not a URL", () => {
    expect(allowed("not a url")).toBe(false);
  });

  it("ignores host casing", () => {
    expect(allowed("https://OUTLOOK.office365.com/adminapi/beta/x/InvokeCommand")).toBe(true);
  });
});
