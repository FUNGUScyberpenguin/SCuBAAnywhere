import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../src/collectors/http.js";
import { CommandTracker } from "../src/collectors/tracker.js";
import { GoogleApiClient } from "../src/collectors/google/api.js";
import { groupMap, orgUnitMap, topLevelOrgUnit } from "../src/collectors/google/directory.js";
import { collectPrivilegedUsers, superAdmins } from "../src/collectors/google/privileged.js";
import { collectActivityLogs } from "../src/collectors/google/reports.js";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

const client = (fetchImpl: typeof fetch) =>
  new GoogleApiClient(new ApiClient({ getToken: async () => "token", fetchImpl }));

describe("directory mapping", () => {
  const orgUnits = [
    { orgUnitId: "id:03ph8a", name: "topOU", orgUnitPath: "/" },
    { orgUnitId: "03ph8b", name: "subOU", orgUnitPath: "/subOU" },
  ];

  it("strips Google's id: prefix", () => {
    expect(orgUnitMap(orgUnits)).toEqual({
      "03ph8a": { name: "topOU", path: "/" },
      "03ph8b": { name: "subOU", path: "/subOU" },
    });
  });

  it("names the tenant after the org unit at the root", () => {
    expect(topLevelOrgUnit(orgUnits)).toBe("topOU");
    expect(topLevelOrgUnit([])).toBe("");
  });

  it("maps groups by email, which is unique, rather than by name", () => {
    expect(groupMap([{ id: "1", email: "a@example.gov" }, { id: "2" }])).toEqual({ "1": "a@example.gov" });
  });
});

describe("privileged users", () => {
  const users = [
    { id: "1", primaryEmail: "admin@example.gov", orgUnitPath: "/", isAdmin: true },
    { id: "2", primaryEmail: "groups@example.gov", orgUnitPath: "/staff" },
    { id: "3", primaryEmail: "normal@example.gov", orgUnitPath: "/staff" },
  ];

  it("lists super admins with the leading slash removed from the org unit", () => {
    expect(superAdmins(users)).toEqual([{ primaryEmail: "admin@example.gov", orgUnitPath: "" }]);
  });

  it("counts a custom role that grants a watched privilege", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/roles")) {
        return json({
          items: [
            { roleId: "r1", roleName: "Helpdesk", rolePrivileges: [{ privilegeName: "USERS_SECURITY" }] },
            { roleId: "r2", roleName: "Reports", rolePrivileges: [{ privilegeName: "REPORTS_ACCESS" }] },
          ],
        });
      }
      if (url.includes("/roleassignments")) {
        return json({
          items: [
            { assignedTo: "2", roleId: "r1", assigneeType: "USER" },
            { assignedTo: "3", roleId: "r2", assigneeType: "USER" },
          ],
        });
      }
      return json({ groups: [{ id: "G1", email: "Admins@Example.gov" }] });
    });


    const result = await collectPrivilegedUsers(client(fetchImpl), "my_customer", users, new CommandTracker());
    expect(result.privileged_users.map((user) => user.primaryEmail)).toEqual([
      "admin@example.gov",
      "groups@example.gov",
    ]);
    // Group keys carry both forms, lowercased, so an SSO target matches either.
    expect(result.privileged_users[0]?.groupKeys).toEqual(["admins@example.gov", "g1"]);
    expect(result.privileged_users_error).toBeNull();
  });

  it("reports a failure rather than an empty list of admins", async () => {
    // An empty list would read as "this tenant has no privileged users", which
    // is the one answer that must never come from a failed call.
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("nope", { status: 403 }));
    const tracker = new CommandTracker();

    const result = await collectPrivilegedUsers(client(fetchImpl), "my_customer", users, tracker);
    expect(result.privileged_users).toEqual([]);
    expect(result.privileged_users_error).toMatch(/HTTP 403/);
    expect(tracker.unsuccessful).toContain("directory/v1/roles/list");
  });

  it("ignores a role assigned to a group rather than a user", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/roles")) return json({ items: [{ roleId: "r1", isSuperAdminRole: true }] });
      if (url.includes("/roleassignments")) {
        return json({ items: [{ assignedTo: "3", roleId: "r1", assigneeType: "GROUP" }] });
      }
      return json({ groups: [] });
    });

    const result = await collectPrivilegedUsers(client(fetchImpl), "my_customer", users, new CommandTracker());
    expect(result.privileged_users.map((user) => user.primaryEmail)).toEqual(["admin@example.gov"]);
  });
});

describe("admin audit log collection", () => {
  const activity = (applicationName: string) => ({
    events: [{ parameters: [{ name: "APPLICATION_NAME", value: applicationName }] }],
  });

  /** A Response body can only be read once, so each call gets a fresh one. */
  const respondPerEvent = (byEvent: Record<string, unknown[]>) =>
    vi.fn<typeof fetch>(async (input) => {
      const event = new URL(String(input)).searchParams.get("eventName") ?? "";
      return json({ items: byEvent[event] ?? [] });
    });

  it("files a shared setting event only against the product it names", async () => {
    // CHANGE_APPLICATION_SETTING is asked for by several products at once, so
    // the APPLICATION_NAME parameter is what keeps a Gmail change out of the
    // Drive log.
    const fetchImpl = respondPerEvent({
      CHANGE_APPLICATION_SETTING: [activity("Gmail"), activity("Drive and Docs"), activity("Calendar")],
    });

    const logs = await collectActivityLogs(client(fetchImpl), ["gmail", "drive"], new CommandTracker());
    expect(logs["gmail_logs"]?.items).toEqual([activity("Gmail")]);
    expect(logs["drive_logs"]?.items).toEqual([activity("Drive and Docs")]);
  });

  it("passes a product-specific event through without filtering", async () => {
    // CHANGE_GMAIL_SETTING can only be Gmail, so upstream does not filter it
    // and neither does this.
    const fetchImpl = respondPerEvent({ CHANGE_GMAIL_SETTING: [activity("Gmail"), activity("Calendar")] });

    const logs = await collectActivityLogs(client(fetchImpl), ["gmail"], new CommandTracker());
    expect(logs["gmail_logs"]?.items).toHaveLength(2);
  });

  it("fetches each event once even when several products want it", async () => {
    const fetchImpl = respondPerEvent({});
    await collectActivityLogs(client(fetchImpl), ["gmail", "drive", "chat"], new CommandTracker());

    const events = fetchImpl.mock.calls.map((call) => new URL(String(call[0])).searchParams.get("eventName"));
    expect(new Set(events).size).toBe(events.length);
  });

  it("gives a product with no log events an empty list rather than nothing", async () => {
    const fetchImpl = respondPerEvent({});
    const logs = await collectActivityLogs(client(fetchImpl), ["calendar", "sites"], new CommandTracker());
    expect(logs["calendar_logs"]).toEqual({ items: [] });
    expect(logs["sites_logs"]).toEqual({ items: [] });
  });

  it("records the failure when the reports API refuses", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("denied", { status: 403 }));
    const tracker = new CommandTracker();

    await collectActivityLogs(client(fetchImpl), ["gmail"], tracker);
    expect(tracker.unsuccessful).toContain("reports/v1/activities/list");
    expect(tracker.successful).not.toContain("reports/v1/activities/list");
  });
});

describe("GoogleApiClient", () => {
  it("follows nextPageToken to the end", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ items: [1], nextPageToken: "next" }))
      .mockResolvedValueOnce(json({ items: [2] }));

    await expect(client(fetchImpl).list("https://admin.googleapis.com/x", "items")).resolves.toEqual([1, 2]);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain("pageToken=next");
  });

  it("tolerates the empty pages Google returns before real content", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ nextPageToken: "a" }))
      .mockResolvedValueOnce(json({ policies: [{ name: "p" }] }));

    await expect(client(fetchImpl).list("https://cloudidentity.googleapis.com/v1/policies", "policies"))
      .resolves.toEqual([{ name: "p" }]);
  });
});
