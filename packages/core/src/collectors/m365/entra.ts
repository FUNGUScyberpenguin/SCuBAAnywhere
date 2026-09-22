import type { ProviderExport } from "../../types.js";
import { CommandTracker } from "../tracker.js";
import type { GraphClient } from "./graph.js";

/** The roles ScubaGear treats as highly privileged (ScubaConfigDefaults.json). */
export const PRIVILEGED_ROLES = [
  "Global Administrator",
  "Privileged Role Administrator",
  "User Administrator",
  "SharePoint Administrator",
  "Exchange Administrator",
  "Hybrid Identity Administrator",
  "Application Administrator",
  "Cloud Application Administrator",
] as const;

/** Entra ID P2, which PIM data depends on. */
const AAD_P2_SERVICE_PLAN = "AAD_PREMIUM_P2";

interface Named { Id?: string; DisplayName?: string }
interface RoleTemplate extends Named {}
interface RoleAssignment { RoleDefinitionId?: string; PrincipalId?: string; StartDateTime?: string | null }
interface DirectoryObject extends Named { "@odata.type"?: string; OnPremisesImmutableId?: string | null }

export interface PrivilegedUser {
  DisplayName: string;
  OnPremisesImmutableId: string | null;
  roles: string[];
}

export interface EntraCollectionOptions {
  graph: GraphClient;
  tracker: CommandTracker;
  /** Merged into the export as `scuba_config`: exclusions, omissions, annotations. */
  scubaConfig?: Record<string, unknown>;
  onProgress?: (step: string) => void;
}

/**
 * Collect the Entra ID configuration the `aad` baseline reads.
 *
 * Every call goes through the tracker, so a collector that fails leaves its
 * policies reported as unevaluated rather than evaluated against nothing.
 */
export async function collectEntra(options: EntraCollectionOptions): Promise<ProviderExport> {
  const { graph, tracker } = options;
  const step = (name: string) => options.onProgress?.(name);

  step("conditional access policies");
  const conditionalAccessPolicies = await tracker.run(
    "Get-MgBetaIdentityConditionalAccessPolicy",
    () => graph.list("/beta/identity/conditionalAccess/policies"),
    [],
  );

  step("licensing");
  const subscribedSkus = await tracker.run(
    "Get-MgBetaSubscribedSku",
    () => graph.list<{ ServicePlans?: unknown[] }>("/beta/subscribedSkus"),
    [],
  );
  const servicePlans = subscribedSkus.flatMap((sku) => (sku.ServicePlans ?? []) as unknown[]);
  const hasPremiumLicense = servicePlans.some(
    (plan) => (plan as { ServicePlanName?: string }).ServicePlanName === AAD_P2_SERVICE_PLAN,
  );

  step("tenant policies");
  const authorizationPolicies = await tracker.run(
    "Get-MgBetaPolicyAuthorizationPolicy",
    async () => asArray(await graph.get("/beta/policies/authorizationPolicy")),
    [],
  );
  const directorySettings = await tracker.run(
    "Get-MgBetaDirectorySetting",
    () => graph.list("/beta/settings"),
    [],
  );
  const authenticationMethod = await tracker.run(
    "Get-MgBetaPolicyAuthenticationMethodPolicy",
    async () => asArray(await graph.get("/beta/policies/authenticationMethodsPolicy")),
    [],
  );
  const domainSettings = await tracker.run("Get-MgBetaDomain", () => graph.list("/beta/domains"), []);
  const userCount = await tracker.run("Get-MgBetaUserCount", () => graph.count("/beta/users/$count"), null);

  step("application policies");
  const defaultAppManagementPolicy = await tracker.run(
    "Get-MgBetaPolicyDefaultAppManagementPolicy",
    async () => asArray(await graph.get("/beta/policies/defaultAppManagementPolicy")),
    [],
  );
  const appManagementPolicies = await tracker.run(
    "Get-MgBetaPolicyAppManagementPolicy",
    () => graph.list("/beta/policies/appManagementPolicies"),
    [],
  );

  step("privileged roles");
  const privilegedRoles = await tracker.run(
    "Get-PrivilegedRole",
    () => collectPrivilegedRoles(graph, hasPremiumLicense),
    [],
  );

  step("privileged users");
  const privilegedUsers = await tracker.run(
    "Get-PrivilegedUser",
    () => collectPrivilegedUsers(graph, hasPremiumLicense),
    {},
  );

  // Not ported yet. Naming them here is what makes MS.AAD.5.4v1 report as
  // unevaluated instead of silently passing on an empty list.
  tracker.skip(
    "Get-ServicePrincipalsWithRiskyDelegatedPermissionClassifications",
    "Risky application permission analysis is not implemented in SCuBAAnywhere yet.",
  );

  return {
    conditional_access_policies: conditionalAccessPolicies,
    authorization_policies: authorizationPolicies,
    directory_settings: directorySettings,
    authentication_method: authenticationMethod,
    domain_settings: domainSettings,
    service_plans: servicePlans,
    total_user_count: userCount,
    default_app_management_policy: defaultAppManagementPolicy,
    app_management_policies: appManagementPolicies,
    privileged_roles: privilegedRoles,
    privileged_users: privilegedUsers,
    risky_delegated_permission_classifications: [],
    scuba_config: options.scubaConfig ?? {},
    aad_successful_commands: tracker.successful,
    aad_unsuccessful_commands: tracker.unsuccessful,
  };
}

/**
 * Privileged roles with their active assignments and PIM rules, matching
 * ScubaGear's Get-PrivilegedRole. Without an Entra ID P2 licence the PIM
 * endpoints return nothing, so only the role list comes back — same as upstream.
 */
async function collectPrivilegedRoles(graph: GraphClient, hasPremiumLicense: boolean) {
  const templates = await graph.list<RoleTemplate>("/beta/directoryRoleTemplates");
  const roles = templates
    .filter((template) => PRIVILEGED_ROLES.includes(template.DisplayName as (typeof PRIVILEGED_ROLES)[number]))
    .map((template) => ({
      DisplayName: template.DisplayName,
      RoleTemplateId: template.Id,
      Assignments: [] as RoleAssignment[],
      Rules: [] as Record<string, unknown>[],
    }));

  if (!hasPremiumLicense) return roles;

  const assignments = await graph.list<RoleAssignment>("/beta/roleManagement/directory/roleAssignmentScheduleInstances");
  const policyAssignments = await graph.list<{ RoleDefinitionId?: string; PolicyId?: string }>(
    "/beta/policies/roleManagementPolicyAssignments?$filter=" +
      encodeURIComponent("scopeId eq '/' and scopeType eq 'DirectoryRole'"),
  );

  for (const role of roles) {
    role.Assignments = assignments.filter((a) => a.RoleDefinitionId === role.RoleTemplateId);

    const assignment = policyAssignments.find((p) => p.RoleDefinitionId === role.RoleTemplateId);
    if (!assignment?.PolicyId) continue;
    const rules = await graph.list<Record<string, unknown>>(
      `/beta/policies/roleManagementPolicies/${encodeURIComponent(assignment.PolicyId)}/rules`,
    );
    // The Rego reports which role a rule came from, so tag each rule at source.
    role.Rules = rules.map((rule) => ({
      ...rule,
      RuleSource: role.DisplayName,
      RuleSourceType: "Directory Role",
    }));
  }
  return roles;
}

/**
 * Everyone holding a privileged role: direct members, members of groups
 * assigned to the role, and PIM-eligible principals when the tenant has P2.
 */
async function collectPrivilegedUsers(
  graph: GraphClient,
  hasPremiumLicense: boolean,
): Promise<Record<string, PrivilegedUser>> {
  const users: Record<string, PrivilegedUser> = {};
  const activeRoles = await graph.list<Named>("/beta/directoryRoles");
  const privileged = activeRoles.filter((role) =>
    PRIVILEGED_ROLES.includes(role.DisplayName as (typeof PRIVILEGED_ROLES)[number]),
  );

  for (const role of privileged) {
    if (!role.Id || !role.DisplayName) continue;
    const members = await graph.list<DirectoryObject>(`/beta/directoryRoles/${role.Id}/members`);
    for (const member of members) {
      await addPrincipal(graph, users, member, role.DisplayName, hasPremiumLicense, 0);
    }
  }

  if (hasPremiumLicense) {
    const eligible = await graph.list<{ RoleDefinitionId?: string; PrincipalId?: string }>(
      "/beta/roleManagement/directory/roleEligibilityScheduleInstances",
    );
    const templates = await graph.list<RoleTemplate>("/beta/directoryRoleTemplates");
    const nameByTemplateId = new Map(templates.map((t) => [t.Id, t.DisplayName]));

    for (const instance of eligible) {
      const roleName = nameByTemplateId.get(instance.RoleDefinitionId);
      if (!roleName || !PRIVILEGED_ROLES.includes(roleName as (typeof PRIVILEGED_ROLES)[number])) continue;
      if (!instance.PrincipalId) continue;
      const principal = await graph.get<DirectoryObject>(`/beta/directoryObjects/${instance.PrincipalId}`);
      if (principal) await addPrincipal(graph, users, principal, roleName, hasPremiumLicense, 0);
    }
  }
  return users;
}

/** Group members count as role holders, so groups are expanded one level at a time. */
const MAX_GROUP_DEPTH = 5;

async function addPrincipal(
  graph: GraphClient,
  users: Record<string, PrivilegedUser>,
  principal: DirectoryObject,
  roleName: string,
  hasPremiumLicense: boolean,
  depth: number,
): Promise<void> {
  const id = principal.Id;
  if (!id) return;
  const type = principal["@odata.type"] ?? "";

  if (type.endsWith("group")) {
    if (depth >= MAX_GROUP_DEPTH) return;
    const members = await graph.list<DirectoryObject>(`/beta/groups/${id}/members`);
    for (const member of members) {
      await addPrincipal(graph, users, member, roleName, hasPremiumLicense, depth + 1);
    }
    if (hasPremiumLicense) {
      const eligible = await graph.list<{ PrincipalId?: string }>(
        "/beta/identityGovernance/privilegedAccess/group/eligibilityScheduleInstances?$filter=" +
          encodeURIComponent(`groupId eq '${id}'`),
      );
      for (const instance of eligible) {
        if (!instance.PrincipalId) continue;
        const member = await graph.get<DirectoryObject>(`/beta/directoryObjects/${instance.PrincipalId}`);
        if (member) await addPrincipal(graph, users, member, roleName, hasPremiumLicense, depth + 1);
      }
    }
    return;
  }

  // Service principals are tracked separately by ScubaGear and are not users.
  if (type.endsWith("servicePrincipal")) return;

  const existing = users[id];
  if (existing) {
    if (!existing.roles.includes(roleName)) existing.roles.push(roleName);
    return;
  }
  users[id] = {
    DisplayName: principal.DisplayName ?? "",
    OnPremisesImmutableId: principal.OnPremisesImmutableId ?? null,
    roles: [roleName],
  };
}

const asArray = (value: unknown): unknown[] => (value === null || value === undefined ? [] : [value]);
