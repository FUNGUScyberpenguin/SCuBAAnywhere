import { ApiClient } from "../http.js";

/**
 * Google's Admin SDK, Cloud Identity and Licensing APIs.
 *
 * Unlike Microsoft's admin APIs, these send the CORS headers a browser needs,
 * so a Google Workspace assessment runs entirely in the page with no relay.
 * Every scope the collectors use is read-only.
 */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/admin.reports.audit.readonly",
  "https://www.googleapis.com/auth/admin.directory.domain.readonly",
  "https://www.googleapis.com/auth/admin.directory.orgunit.readonly",
  "https://www.googleapis.com/auth/admin.directory.user.readonly",
  "https://www.googleapis.com/auth/admin.directory.rolemanagement.readonly",
  "https://www.googleapis.com/auth/admin.directory.group.readonly",
  "https://www.googleapis.com/auth/admin.directory.customer.readonly",
  "https://www.googleapis.com/auth/cloud-identity.policies.readonly",
  "https://www.googleapis.com/auth/cloud-identity.inboundsso.readonly",
  "https://www.googleapis.com/auth/apps.groups.settings",
] as const;

/** The single scope string a browser token client asks for. */
export const GOOGLE_SCOPE_STRING = GOOGLE_SCOPES.join(" ");

export const ADMIN_SDK = "https://admin.googleapis.com";
export const CLOUD_IDENTITY = "https://cloudidentity.googleapis.com";
export const GROUPS_SETTINGS = "https://www.googleapis.com/groups/v1/groups";

/**
 * Names for each API call, matching the `successful_calls` and
 * `unsuccessful_calls` strings ScubaGoggles writes. The Rego reads them to
 * decide which policies it cannot evaluate, so they have to match exactly.
 */
export const GOOGLE_API_CALLS = {
  listUsers: "directory/v1/users/list",
  listOrgUnits: "directory/v1/orgunits/list",
  listDomains: "directory/v1/domains/list",
  listAliasDomains: "directory/reference/rest/v1/domainAliases/list",
  listGroups: "directory/v1/groups/list",
  listRoles: "directory/v1/roles/list",
  listRoleAssignments: "directory/v1/roleAssignments/list",
  listInboundSsoAssignments: "cloudidentity/v1/inboundSsoAssignments/list",
  getCustomer: "directory/v1/customer/get",
  listActivities: "reports/v1/activities/list",
  getGroup: "groups-settings/v1/groups/get",
} as const;

/** Reads Google's paginated JSON APIs with one access token. */
export class GoogleApiClient {
  constructor(private readonly api: ApiClient) {}

  async get<T>(url: string, params: Record<string, string | number | undefined> = {}): Promise<T | null> {
    return this.api.request<T>(withParams(url, params), {
      scope: GOOGLE_SCOPE_STRING,
      corsSafe: true,
    });
  }

  /**
   * Collect `key` across every page. Google returns `nextPageToken` until the
   * last page, and some endpoints return empty pages before the real content.
   */
  async list<T>(
    url: string,
    key: string,
    params: Record<string, string | number | undefined> = {},
  ): Promise<T[]> {
    const items: T[] = [];
    let pageToken: string | undefined;

    do {
      const page = await this.get<Record<string, unknown>>(url, { ...params, pageToken });
      if (!page) break;
      const batch = page[key];
      if (Array.isArray(batch)) items.push(...(batch as T[]));
      pageToken = typeof page["nextPageToken"] === "string" ? page["nextPageToken"] : undefined;
    } while (pageToken);

    return items;
  }
}

function withParams(url: string, params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, value]) => value !== undefined && value !== "");
  if (entries.length === 0) return url;
  const query = new URLSearchParams(entries.map(([key, value]) => [key, String(value)]));
  return `${url}${url.includes("?") ? "&" : "?"}${query.toString()}`;
}
