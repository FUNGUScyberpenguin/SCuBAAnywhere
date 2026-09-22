import { describe, expect, it, vi } from "vitest";
import { ApiClient, HttpError, redactUrl } from "../src/collectors/http.js";
import { GraphClient, pascalize } from "../src/collectors/m365/graph.js";
import { CommandTracker } from "../src/collectors/tracker.js";
import { sortPolicies } from "../src/collectors/m365/exchange.js";
import { detectSuite, productsPresent } from "../src/suite.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("pascalize", () => {
  it("capitalises keys the way the PowerShell SDK does", () => {
    expect(pascalize({ displayName: "Contoso", isRoot: true })).toEqual({ DisplayName: "Contoso", IsRoot: true });
  });

  it("recurses through nested objects and arrays", () => {
    expect(pascalize({ conditions: { users: [{ includeRoles: ["a"] }] } })).toEqual({
      Conditions: { Users: [{ IncludeRoles: ["a"] }] },
    });
  });

  it("leaves OData annotations alone", () => {
    expect(pascalize({ "@odata.type": "#microsoft.graph.user" })).toEqual({
      "@odata.type": "#microsoft.graph.user",
    });
  });

  it("passes primitives through untouched", () => {
    expect(pascalize(null)).toBeNull();
    expect(pascalize(7)).toBe(7);
  });
});

describe("GraphClient", () => {
  const client = (fetchImpl: typeof fetch) =>
    new GraphClient(new ApiClient({ getToken: async () => "token", fetchImpl }), "commercial");

  it("follows @odata.nextLink to the end", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ value: [{ id: "1" }], "@odata.nextLink": "https://graph.microsoft.com/page2" }))
      .mockResolvedValueOnce(json({ value: [{ id: "2" }] }));

    const items = await client(fetchImpl).list("/beta/domains");
    expect(items).toEqual([{ Id: "1" }, { Id: "2" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("raises a permission failure instead of reporting no data", async () => {
    // A 403 means the account cannot read this. Swallowing it would hand the
    // Rego an empty object and turn a blind spot into a passing policy; the
    // collector needs the failure so the affected policies report unevaluated.
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("Forbidden", { status: 403 }));
    await expect(client(fetchImpl).get("/beta/policies/authorizationPolicy")).rejects.toThrow(/HTTP 403/);
  });

  it("and a tracked collector turns that failure into an unevaluated policy", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("Forbidden", { status: 403 }));
    const tracker = new CommandTracker();
    const value = await tracker.run(
      "Get-MgBetaPolicyAuthorizationPolicy",
      () => client(fetchImpl).get("/beta/policies/authorizationPolicy"),
      null,
    );
    expect(value).toBeNull();
    expect(tracker.unsuccessful).toEqual(["Get-MgBetaPolicyAuthorizationPolicy"]);
  });

  it("sends a bearer token", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ value: [] }));
    await client(fetchImpl).list("/beta/domains");
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer token");
  });
});

describe("ApiClient", () => {
  it("retries a 429 and then succeeds", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("slow down", { status: 429, headers: { "Retry-After": "0" } }))
      .mockResolvedValueOnce(json({ ok: true }));

    const api = new ApiClient({ getToken: async () => "t", fetchImpl });
    await expect(api.request("https://graph.microsoft.com/beta/x", { scope: "s", corsSafe: true }))
      .resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("routes a host without CORS through the relay", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ value: [] }));
    const api = new ApiClient({ getToken: async () => "t", fetchImpl, relayUrl: "https://relay.example/" });
    await api.request("https://outlook.office365.com/adminapi/beta/t/InvokeCommand", { scope: "s", corsSafe: false });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://relay.example/v1/forward?target=" +
        encodeURIComponent("https://outlook.office365.com/adminapi/beta/t/InvokeCommand"),
    );
  });

  it("explains itself when a relayed host is needed and no relay is set", async () => {
    const api = new ApiClient({ getToken: async () => "t", fetchImpl: vi.fn() });
    await expect(api.request("https://outlook.office365.com/x", { scope: "s", corsSafe: false }))
      .rejects.toThrow(/no relay is configured/);
  });

  it("keeps query strings out of error messages", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("nope", { status: 400 }));
    const api = new ApiClient({ getToken: async () => "t", fetchImpl });
    const error = await api
      .request("https://graph.microsoft.com/beta/users?$filter=secret", { scope: "s", corsSafe: true })
      .catch((e) => e as HttpError);
    expect(error.message).not.toContain("secret");
    expect(redactUrl("https://graph.microsoft.com/beta/users?$filter=secret"))
      .toBe("https://graph.microsoft.com/beta/users");
  });
});

describe("CommandTracker", () => {
  it("records successes and failures separately", async () => {
    const tracker = new CommandTracker();
    await tracker.run("Get-Works", async () => "value", "fallback");
    await tracker.run("Get-Breaks", async () => { throw new Error("403"); }, "fallback");

    expect(tracker.successful).toEqual(["Get-Works"]);
    expect(tracker.unsuccessful).toEqual(["Get-Breaks"]);
  });

  it("returns the fallback when a collector fails", async () => {
    const tracker = new CommandTracker();
    await expect(tracker.run("Get-Breaks", async () => { throw new Error("nope"); }, [])).resolves.toEqual([]);
  });
});

describe("sortPolicies", () => {
  it("puts Strict then Standard preset policies first, then sorts by priority", () => {
    const sorted = sortPolicies([
      { Name: "Custom B", Priority: 2 },
      { Name: "Standard Preset Security Policy1", Priority: 9 },
      { Name: "Custom A", Priority: 1 },
      { Name: "Strict Preset Security Policy1", Priority: 8 },
    ]);
    expect(sorted.map((p) => p["Name"])).toEqual([
      "Strict Preset Security Policy1",
      "Standard Preset Security Policy1",
      "Custom A",
      "Custom B",
    ]);
  });
});

describe("detectSuite", () => {
  it("recognises a ScubaGear export", () => {
    expect(detectSuite({ conditional_access_policies: [] })).toBe("m365");
    expect(detectSuite({ teams_successful_commands: [] })).toBe("m365");
  });

  it("recognises a ScubaGoggles export", () => {
    expect(detectSuite({ policies: {}, tenant_info: {} })).toBe("gws");
  });

  it("returns null for anything else", () => {
    expect(detectSuite({ hello: "world" })).toBeNull();
  });

  it("lists only the products an export carries data for", () => {
    expect(productsPresent("m365", { aad_successful_commands: [], teams_successful_commands: [] }))
      .toEqual(["aad", "teams"]);
  });
});
