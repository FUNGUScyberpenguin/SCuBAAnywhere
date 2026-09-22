import type { ProviderExport } from "../../types.js";
import type { ApiClient } from "../http.js";
import { CommandTracker } from "../tracker.js";
import { endpointFor, sharePointEndpoint, type M365Environment } from "./endpoints.js";

/**
 * SharePoint, Teams and Power Platform. Each is a handful of REST reads against
 * an admin endpoint, using the same shapes ScubaGear's REST helpers produce.
 * None of these hosts allow browser origins, so all of it goes via the relay.
 */

export interface WorkloadOptions {
  api: ApiClient;
  environment: M365Environment;
  tracker: CommandTracker;
  onProgress?: (step: string) => void;
}

export interface SharePointOptions extends WorkloadOptions {
  /** Tenant prefix, i.e. `contoso` for contoso.onmicrosoft.com. */
  domainPrefix: string;
}

export async function collectSharePoint(options: SharePointOptions): Promise<ProviderExport> {
  const { tracker } = options;
  const endpoint = sharePointEndpoint(options.domainPrefix, options.environment);
  options.onProgress?.("SharePoint tenant settings");

  const tenant = await tracker.run(
    "Get-SPOTenant",
    async () => {
      const body = await options.api.request<{ d?: unknown }>(`${endpoint.baseUrl}/_api/SPO.Tenant`, {
        scope: endpoint.scope,
        corsSafe: endpoint.corsSafe,
        headers: { Accept: "application/json;odata=verbose", "Content-Type": "application/json;odata=verbose" },
      });
      return body?.d ?? null;
    },
    null,
  );

  return {
    SPO_tenant: tenant === null ? [] : [tenant],
    // ScubaGear sets this when it had to fall back to PnP for OneDrive settings.
    // SCuBAAnywhere reads the tenant object directly, so it is always false.
    OneDrive_PnP_Flag: false,
    SharePoint_successful_commands: tracker.successful,
    SharePoint_unsuccessful_commands: tracker.unsuccessful,
  };
}

const TEAMS_ENDPOINTS = {
  "Get-CsTeamsMeetingPolicy": "/Skype.Policy/configurations/TeamsMeetingPolicy",
  "Get-CsTenantFederationConfiguration": "/Skype.Policy/configurations/TenantFederationSettings",
  "Get-CsTeamsClientConfiguration": "/Skype.Policy/configurations/TeamsClientConfiguration",
  "Get-CsTeamsAppPermissionPolicy": "/Skype.Policy/configurations/TeamsAppPermissionPolicy",
  "Get-CsTeamsMeetingBroadcastPolicy": "/Skype.Policy/configurations/TeamsMeetingBroadcastPolicy",
} as const;

export async function collectTeams(options: WorkloadOptions): Promise<ProviderExport> {
  const { tracker } = options;
  const endpoint = endpointFor("teams", options.environment);
  options.onProgress?.("Teams policies");

  const read = (command: keyof typeof TEAMS_ENDPOINTS) =>
    tracker.run(
      command,
      async () => {
        const body = await options.api.request<unknown>(`${endpoint.baseUrl}${TEAMS_ENDPOINTS[command]}`, {
          scope: endpoint.scope,
          corsSafe: endpoint.corsSafe,
        });
        return asArray(body);
      },
      [],
    );

  const meetingPolicies = await read("Get-CsTeamsMeetingPolicy");
  const federationConfiguration = await read("Get-CsTenantFederationConfiguration");
  const clientConfiguration = await read("Get-CsTeamsClientConfiguration");
  const appPolicies = await read("Get-CsTeamsAppPermissionPolicy");
  const broadcastPolicies = await read("Get-CsTeamsMeetingBroadcastPolicy");

  // Unified app settings live on a different host with its own token audience,
  // so it is left out until the relay is configured for it.
  tracker.skip("Get-CsTeamsUnifiedAppSettings", "Teams unified app settings are not collected yet.");

  return {
    meeting_policies: meetingPolicies,
    federation_configuration: federationConfiguration,
    client_configuration: clientConfiguration,
    app_policies: appPolicies,
    broadcast_policies: broadcastPolicies,
    tenant_app_settings: [],
    teams_successful_commands: tracker.successful,
    teams_unsuccessful_commands: tracker.unsuccessful,
  };
}

export interface PowerPlatformOptions extends WorkloadOptions {
  tenantId: string;
}

export async function collectPowerPlatform(options: PowerPlatformOptions): Promise<ProviderExport> {
  const { tracker, tenantId } = options;
  const endpoint = endpointFor("powerPlatform", options.environment);
  options.onProgress?.("Power Platform tenant settings");

  const read = <T>(command: string, path: string, method: "GET" | "POST" = "GET") =>
    tracker.run(
      command,
      () =>
        options.api.request<T>(`${endpoint.baseUrl}${path}`, {
          method,
          scope: endpoint.scope,
          corsSafe: endpoint.corsSafe,
        }),
      null,
    );

  const tenantSettings = await read<Record<string, unknown>>(
    "Get-TenantSettings",
    "/providers/Microsoft.BusinessAppPlatform/listTenantSettings?api-version=2023-06-01",
    "POST",
  );
  const environments = await read<{ value?: unknown[] }>(
    "Get-AdminPowerAppEnvironment",
    "/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments?api-version=2023-06-01",
  );
  const dlpPolicies = await read<{ value?: unknown[] }>(
    "Get-DlpPolicy",
    "/providers/Microsoft.BusinessAppPlatform/scopes/admin/apiPolicies?api-version=2016-11-01",
  );
  const tenantIsolation = await read<Record<string, unknown>>(
    "Get-PowerAppTenantIsolationPolicy",
    `/providers/PowerPlatform.Governance/v1/tenants/${encodeURIComponent(tenantId)}` +
      "/tenantIsolationPolicy?api-version=2020-06-01",
  );

  return {
    tenant_id: tenantId,
    environment_creation: tenantSettings === null ? [] : [tenantSettings],
    environment_list: environments?.value ?? [],
    dlp_policies: dlpPolicies === null ? [] : [dlpPolicies],
    tenant_isolation: tenantIsolation === null ? [] : [tenantIsolation],
    powerplatform_successful_commands: tracker.successful,
    powerplatform_unsuccessful_commands: tracker.unsuccessful,
  };
}

const asArray = (value: unknown): unknown[] => {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value;
  const collection = value as { value?: unknown[] };
  return Array.isArray(collection.value) ? collection.value : [value];
};
