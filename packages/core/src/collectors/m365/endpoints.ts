/**
 * Where each Microsoft 365 admin surface lives, and which OAuth resource a
 * token has to be minted for. Taken from ScubaGear's own API catalog
 * (PowerShell/ScubaGear/schemas/ScubaGearApiCatalog.json) so the two tools call
 * the same endpoints.
 *
 * `corsSafe` records whether a browser can call the host directly. Only
 * Microsoft Graph sends the CORS headers a single-page app needs; the admin
 * APIs behind the other products do not, so those calls go through the relay.
 */
export type M365Environment = "commercial" | "gcc" | "gcchigh" | "dod";

export interface ServiceEndpoint {
  /** Origin to call. `{domain}` is the tenant's SharePoint domain prefix. */
  baseUrl: string;
  /** Scope to request when acquiring the access token for this service. */
  scope: string;
  corsSafe: boolean;
}

type EnvMap = Record<M365Environment, ServiceEndpoint>;

const graph: EnvMap = {
  commercial: { baseUrl: "https://graph.microsoft.com", scope: "https://graph.microsoft.com/.default", corsSafe: true },
  gcc: { baseUrl: "https://graph.microsoft.com", scope: "https://graph.microsoft.com/.default", corsSafe: true },
  gcchigh: { baseUrl: "https://graph.microsoft.us", scope: "https://graph.microsoft.us/.default", corsSafe: true },
  dod: { baseUrl: "https://dod-graph.microsoft.us", scope: "https://dod-graph.microsoft.us/.default", corsSafe: true },
};

const exchange: EnvMap = {
  commercial: { baseUrl: "https://outlook.office365.com", scope: "https://outlook.office365.com/.default", corsSafe: false },
  gcc: { baseUrl: "https://outlook.office365.com", scope: "https://outlook.office365.com/.default", corsSafe: false },
  gcchigh: { baseUrl: "https://outlook.office365.us", scope: "https://outlook.office365.us/.default", corsSafe: false },
  dod: { baseUrl: "https://outlook-dod.office365.us", scope: "https://outlook-dod.office365.us/.default", corsSafe: false },
};

const compliance: EnvMap = {
  commercial: { baseUrl: "https://ps.compliance.protection.outlook.com", scope: "https://ps.compliance.protection.outlook.com/.default", corsSafe: false },
  gcc: { baseUrl: "https://ps.compliance.protection.outlook.com", scope: "https://ps.compliance.protection.outlook.com/.default", corsSafe: false },
  gcchigh: { baseUrl: "https://ps.compliance.protection.office365.us", scope: "https://ps.compliance.protection.office365.us/.default", corsSafe: false },
  dod: { baseUrl: "https://ps.compliance.protection.office365.us", scope: "https://ps.compliance.protection.office365.us/.default", corsSafe: false },
};

const TEAMS_APP_ID = "48ac35b8-9aa8-4d74-927d-1f4a14a0b239";

const teams: EnvMap = {
  commercial: { baseUrl: "https://api.interfaces.records.teams.microsoft.com", scope: `${TEAMS_APP_ID}/.default`, corsSafe: false },
  gcc: { baseUrl: "https://api.interfaces.records.teams.microsoft.com", scope: `${TEAMS_APP_ID}/.default`, corsSafe: false },
  gcchigh: { baseUrl: "https://api.interfaces.records.gov.teams.microsoft.us", scope: `${TEAMS_APP_ID}/.default`, corsSafe: false },
  dod: { baseUrl: "https://api.interfaces.records.gov.teams.microsoft.us", scope: `${TEAMS_APP_ID}/.default`, corsSafe: false },
};

const powerPlatform: EnvMap = {
  commercial: { baseUrl: "https://api.bap.microsoft.com", scope: "https://service.powerapps.com//.default", corsSafe: false },
  gcc: { baseUrl: "https://gov.api.bap.microsoft.us", scope: "https://gov.service.powerapps.us//.default", corsSafe: false },
  gcchigh: { baseUrl: "https://high.api.bap.microsoft.us", scope: "https://high.service.powerapps.us//.default", corsSafe: false },
  dod: { baseUrl: "https://api.appsplatform.us", scope: "https://service.apps.appsplatform.us//.default", corsSafe: false },
};

const sharePointSuffix: Record<M365Environment, string> = {
  commercial: "sharepoint.com",
  gcc: "sharepoint.com",
  gcchigh: "sharepoint.us",
  dod: "sharepoint-mil.us",
};

export const ENDPOINTS = { graph, exchange, compliance, teams, powerPlatform } as const;
export type ServiceName = keyof typeof ENDPOINTS;

export function endpointFor(service: ServiceName, environment: M365Environment): ServiceEndpoint {
  return ENDPOINTS[service][environment];
}

/** SharePoint's admin API lives on a per-tenant host, so it is built, not looked up. */
export function sharePointEndpoint(domainPrefix: string, environment: M365Environment): ServiceEndpoint {
  const baseUrl = `https://${domainPrefix}-admin.${sharePointSuffix[environment]}`;
  return { baseUrl, scope: `${baseUrl}/.default`, corsSafe: false };
}

/** Every origin the app may talk to, for the relay allowlist and the page's CSP. */
export function allOrigins(environment: M365Environment): string[] {
  const origins = new Set<string>();
  for (const service of Object.keys(ENDPOINTS) as ServiceName[]) {
    origins.add(ENDPOINTS[service][environment].baseUrl);
  }
  return [...origins];
}
