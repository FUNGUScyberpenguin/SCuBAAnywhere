import { ADMIN_SDK, GOOGLE_API_CALLS, GoogleApiClient } from "./api.js";
import type { DirectoryUser } from "./directory.js";
import type { CommandTracker } from "../tracker.js";

const DIRECTORY = `${ADMIN_SDK}/admin/directory/v1`;

/**
 * Privileges that make an admin role highly privileged for GWS.COMMONCONTROLS.6.
 * A custom role granting any of these counts, which is why the check is on
 * privileges rather than on role names.
 *
 * Super Admin is not in this set: Google marks it with `isSuperAdminRole`
 * rather than a privilege.
 */
const HIGHLY_PRIVILEGED_PRIVILEGES = new Set([
  "ADMIN_OAUTH_PRIVILEGE_GROUP",
  "ADMIN_ROLE_MANAGEMENT",
  "GROUPS_ALL",
  "MANAGE_USER_LICENSES",
  "MOBILE_ALL",
  "ORGANIZATION_UNITS_ALL",
  "SERVICES_ALL",
  "USERS_ALL",
  "USERS_CREATE",
  "USERS_SECURITY",
  "USERS_UPDATE",
]);

/** Fallback for tenants whose role privileges do not match the identifiers above. */
const HIGHLY_PRIVILEGED_ROLE_NAMES = new Set([
  "SUPER_ADMIN",
  "_SEED_ADMIN_ROLE",
  "USER MANAGEMENT ADMIN",
  "USER MANAGEMENT ADMINISTRATOR",
  "SERVICES ADMIN",
  "MOBILE ADMIN",
  "GROUPS ADMIN",
]);

interface Role {
  roleId?: string;
  roleName?: string;
  isSuperAdminRole?: boolean;
  rolePrivileges?: Array<{ privilegeName?: string }>;
}

interface RoleAssignment {
  assignedTo?: string;
  roleId?: string;
  assigneeType?: string;
}

export interface GwsPrivilegedUser {
  primaryEmail: string;
  orgUnitPath: string;
  /** Group ids and emails, lowercased, so SSO targets match either form. */
  groupKeys: string[];
}

export interface SuperAdmin {
  primaryEmail: string;
  orgUnitPath: string;
}

/** Super admins, with the leading slash stripped from the org unit path. */
export function superAdmins(users: DirectoryUser[]): SuperAdmin[] {
  return users
    .filter((user) => user.isAdmin)
    .map((user) => ({
      primaryEmail: user.primaryEmail ?? "",
      orgUnitPath: stripLeadingSlash(user.orgUnitPath ?? ""),
    }));
}

export interface PrivilegedUsersResult {
  privileged_users: GwsPrivilegedUser[];
  privileged_users_error: string | null;
}

/**
 * Everyone holding a highly privileged role: super admins, anyone assigned the
 * Super Admin role, and anyone assigned a role granting one of the watched
 * privileges. Delegated admins are included as a safety net, because some
 * tenants do not return enough role metadata to map their assignments.
 */
export async function collectPrivilegedUsers(
  google: GoogleApiClient,
  customerId: string,
  users: DirectoryUser[],
  tracker: CommandTracker,
): Promise<PrivilegedUsersResult> {
  const calls = [GOOGLE_API_CALLS.listRoles, GOOGLE_API_CALLS.listRoleAssignments];

  try {
    const roles = await google.list<Role>(`${DIRECTORY}/customer/${encodeURIComponent(customerId)}/roles`, "items");
    const privilegedRoleIds = new Set(
      roles.filter(isPrivilegedRole).map((role) => role.roleId).filter((id): id is string => Boolean(id)),
    );

    const assignments = await google.list<RoleAssignment>(
      `${DIRECTORY}/customer/${encodeURIComponent(customerId)}/roleassignments`,
      "items",
    );

    const privilegedIds = new Set<string>();
    for (const user of users) {
      if ((user.isAdmin || user.isDelegatedAdmin) && user.id) privilegedIds.add(user.id);
    }
    for (const assignment of assignments) {
      if ((assignment.assigneeType ?? "USER") !== "USER") continue;
      if (assignment.roleId && privilegedRoleIds.has(assignment.roleId) && assignment.assignedTo) {
        privilegedIds.add(assignment.assignedTo);
      }
    }

    const records: GwsPrivilegedUser[] = [];
    const seen = new Set<string>();
    for (const user of users) {
      if (!user.id || !privilegedIds.has(user.id)) continue;
      const email = user.primaryEmail ?? "";
      if (seen.has(email)) continue;
      seen.add(email);
      records.push({
        primaryEmail: email,
        orgUnitPath: stripLeadingSlash(user.orgUnitPath ?? ""),
        groupKeys: await groupKeysFor(google, email),
      });
    }

    for (const call of calls) tracker.successful.push(call);
    return { privileged_users: records, privileged_users_error: null };
  } catch (error) {
    // GWS.COMMONCONTROLS.6.1 cannot be evaluated without this, so the failure
    // is recorded rather than returned as an empty list of privileged users.
    const message = error instanceof Error ? error.message : String(error);
    for (const call of calls) tracker.failures.push({ command: call, message });
    return { privileged_users: [], privileged_users_error: message };
  }
}

function isPrivilegedRole(role: Role): boolean {
  if (role.isSuperAdminRole) return true;
  if (HIGHLY_PRIVILEGED_ROLE_NAMES.has(String(role.roleName ?? "").toUpperCase())) return true;
  return (role.rolePrivileges ?? []).some(
    (privilege) => privilege.privilegeName && HIGHLY_PRIVILEGED_PRIVILEGES.has(privilege.privilegeName),
  );
}

async function groupKeysFor(google: GoogleApiClient, userEmail: string): Promise<string[]> {
  if (!userEmail) return [];
  const groups = await google.list<{ id?: string; email?: string }>(`${DIRECTORY}/groups`, "groups", {
    userKey: userEmail,
  });

  const keys = new Set<string>();
  for (const group of groups) {
    const id = String(group.id ?? "").trim().toLowerCase();
    const email = String(group.email ?? "").trim().toLowerCase();
    if (id) keys.add(id);
    if (email) keys.add(email);
  }
  return [...keys].sort();
}

const stripLeadingSlash = (path: string) => (path.startsWith("/") ? path.slice(1) : path);
