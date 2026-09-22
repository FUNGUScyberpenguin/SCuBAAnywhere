import { ADMIN_SDK, CLOUD_IDENTITY, GOOGLE_API_CALLS, GoogleApiClient } from "./api.js";
import type { GroupMap, OrgUnitMap } from "./types.js";
import type { CommandTracker } from "../tracker.js";

const DIRECTORY = `${ADMIN_SDK}/admin/directory/v1`;

export interface OrgUnit {
  orgUnitId: string;
  name: string;
  orgUnitPath: string;
}

export interface Domain {
  domainName: string;
  isPrimary?: boolean;
  verified?: boolean;
}

export interface DirectoryUser {
  id?: string;
  primaryEmail?: string;
  orgUnitPath?: string;
  isAdmin?: boolean;
  isDelegatedAdmin?: boolean;
}

export interface DirectoryGroup {
  id?: string;
  email?: string;
}

/**
 * The Admin SDK reads that back the Policy API: who the org units and groups
 * are, which domains the tenant owns, and who holds admin rights.
 */
export class DirectoryCollector {
  constructor(
    private readonly google: GoogleApiClient,
    private readonly customerId: string,
    private readonly tracker: CommandTracker,
  ) {}

  /** Every org unit including the top-level one, which carries the tenant name. */
  async orgUnits(): Promise<OrgUnit[]> {
    return this.tracker.run(
      GOOGLE_API_CALLS.listOrgUnits,
      async () => {
        const response = await this.google.get<{ organizationUnits?: OrgUnit[] }>(
          `${DIRECTORY}/customer/${encodeURIComponent(this.customerId)}/orgunits`,
          { orgUnitPath: "/", type: "all_including_parent" },
        );
        return response?.organizationUnits ?? [];
      },
      [],
    );
  }

  async groups(): Promise<DirectoryGroup[]> {
    return this.tracker.run(
      GOOGLE_API_CALLS.listGroups,
      () => this.google.list<DirectoryGroup>(`${DIRECTORY}/groups`, "groups", { customer: this.customerId }),
      [],
    );
  }

  async domains(): Promise<Domain[]> {
    return this.tracker.run(
      GOOGLE_API_CALLS.listDomains,
      async () =>
        (await this.google.get<{ domains?: Domain[] }>(
          `${DIRECTORY}/customer/${encodeURIComponent(this.customerId)}/domains`,
        ))?.domains ?? [],
      [],
    );
  }

  async aliasDomains(): Promise<Array<{ domainAliasName: string; verified?: boolean }>> {
    return this.tracker.run(
      GOOGLE_API_CALLS.listAliasDomains,
      async () =>
        (await this.google.get<{ domainAliases?: Array<{ domainAliasName: string; verified?: boolean }> }>(
          `${DIRECTORY}/customer/${encodeURIComponent(this.customerId)}/domainaliases`,
        ))?.domainAliases ?? [],
      [],
    );
  }

  async users(): Promise<DirectoryUser[]> {
    return this.tracker.run(
      GOOGLE_API_CALLS.listUsers,
      () => this.google.list<DirectoryUser>(`${DIRECTORY}/users`, "users", { customer: this.customerId }),
      [],
    );
  }

  /** The canonical customer id, which the Cloud Identity API needs. */
  async canonicalCustomerId(): Promise<string | null> {
    if (this.customerId !== "my_customer") return this.customerId;
    return this.tracker.run(
      GOOGLE_API_CALLS.getCustomer,
      async () => {
        const customer = await this.google.get<{ id?: string }>(
          `${DIRECTORY}/customers/${encodeURIComponent(this.customerId)}`,
        );
        return customer?.id?.trim() || null;
      },
      null,
    );
  }
}

/** Org unit id to name and path, as the policy reduction needs it. */
export function orgUnitMap(orgUnits: OrgUnit[]): OrgUnitMap {
  const map: OrgUnitMap = {};
  for (const orgUnit of orgUnits) {
    const id = orgUnit.orgUnitId.replace(/^id:/, "");
    map[id] = { name: orgUnit.name, path: orgUnit.orgUnitPath };
  }
  return map;
}

/**
 * Group id to email. The email is used rather than the name because a group
 * name need not be unique, and the operator's exclusion config names groups by
 * email.
 */
export function groupMap(groups: DirectoryGroup[]): GroupMap {
  const map: GroupMap = {};
  for (const group of groups) {
    if (group.id && group.email) map[group.id] = group.email;
  }
  return map;
}

/** The tenant name, which is the name of the org unit at path `/`. */
export function topLevelOrgUnit(orgUnits: OrgUnit[]): string {
  return orgUnits.find((orgUnit) => orgUnit.orgUnitPath === "/")?.name ?? "";
}

export interface InboundSsoResult {
  inbound_sso_assignments: unknown[];
  inbound_sso_assignments_error: string | null;
}

/**
 * Inbound SSO assignments, which decide whether the SSO policy applies to the
 * privileged users the baseline cares about.
 */
export async function collectInboundSso(
  google: GoogleApiClient,
  canonicalCustomerId: string | null,
  tracker: CommandTracker,
): Promise<InboundSsoResult> {
  if (!canonicalCustomerId) {
    const message = "The canonical customer id could not be resolved, so SSO assignments were not read.";
    tracker.skip(GOOGLE_API_CALLS.listInboundSsoAssignments, message);
    return { inbound_sso_assignments: [], inbound_sso_assignments_error: message };
  }

  const before = tracker.failures.length;
  const assignments = await tracker.run(
    GOOGLE_API_CALLS.listInboundSsoAssignments,
    () =>
      google.list<unknown>(`${CLOUD_IDENTITY}/v1/inboundSsoAssignments`, "inboundSsoAssignments", {
        filter: `customer=="customers/${canonicalCustomerId}"`,
        pageSize: 100,
      }),
    [],
  );

  const failure = tracker.failures[before];
  return {
    inbound_sso_assignments: assignments,
    // The Rego distinguishes "no assignments" from "could not look", so the
    // error is reported rather than folded into an empty list.
    inbound_sso_assignments_error: failure ? failure.message : null,
  };
}
