import type { M365Product, ProviderExport } from "../../types.js";
import type { ApiClient } from "../http.js";
import type { DnsOptions } from "../dns.js";
import { CommandTracker } from "../tracker.js";
import { GraphClient } from "./graph.js";
import { collectEntra } from "./entra.js";
import { collectExchange, collectSecuritySuite } from "./exchange.js";
import { collectPowerPlatform, collectSharePoint, collectTeams } from "./workloads.js";
import type { M365Environment } from "./endpoints.js";

export interface TenantDetails {
  id: string;
  displayName: string;
  /** Default `*.onmicrosoft.com` domain, which gives the SharePoint host prefix. */
  initialDomain: string;
  domainPrefix: string;
}

export async function readTenantDetails(graph: GraphClient): Promise<TenantDetails> {
  const organizations = await graph.list<{
    Id?: string;
    DisplayName?: string;
    VerifiedDomains?: Array<{ Name?: string; IsInitial?: boolean }>;
  }>("/beta/organization");

  const organization = organizations[0];
  if (!organization?.Id) throw new Error("Could not read the tenant from Microsoft Graph.");

  const initial = organization.VerifiedDomains?.find((domain) => domain.IsInitial)?.Name ?? "";
  return {
    id: organization.Id,
    displayName: organization.DisplayName ?? organization.Id,
    initialDomain: initial,
    domainPrefix: initial.replace(/\.onmicrosoft\.(com|us)$/i, ""),
  };
}

export interface M365RunOptions {
  api: ApiClient;
  environment: M365Environment;
  products: M365Product[];
  tenant: TenantDetails;
  /** Omit to skip the SPF/DKIM/DMARC lookups. */
  dns?: DnsOptions;
  scubaConfig?: Record<string, unknown>;
  onProgress?: (product: M365Product, step: string) => void;
}

export interface M365Collection {
  /** Everything the collectors gathered, merged as the Rego expects to read it. */
  export: ProviderExport;
  /** Per product, the collectors that did not run. */
  failedCollectors: Record<string, string[]>;
  /** Why each one failed, for the run log. */
  failures: Record<string, string>;
}

/**
 * Run the collectors for the selected products and merge their output into one
 * settings export, the same document ScubaGear writes to disk. Here it stays in
 * memory.
 */
export async function collectM365(options: M365RunOptions): Promise<M365Collection> {
  const { api, environment, tenant } = options;
  const graph = new GraphClient(api, environment);
  const merged: ProviderExport = { tenant_details: tenant };
  const failedCollectors: Record<string, string[]> = {};
  const failures: Record<string, string> = {};

  const record = (product: M365Product, tracker: CommandTracker) => {
    failedCollectors[product] = tracker.unsuccessful;
    for (const failure of tracker.failures) failures[failure.command] = failure.message;
  };

  // The Security Suite licence checks read the tenant's service plans, which
  // the Entra collection already fetches, so Entra runs first when it is also
  // selected. When it is not, only the subscribed SKUs are read: collecting the
  // whole Entra baseline to answer a licence question would read privileged
  // user data nobody asked for.
  const wantsEntra = options.products.includes("aad");
  const wantsSecuritySuite = options.products.includes("securitysuite") || options.products.includes("defender");

  let servicePlans: unknown[] = [];
  if (wantsEntra) {
    const tracker = new CommandTracker();
    const entra = await collectEntra({
      graph,
      tracker,
      scubaConfig: options.scubaConfig ?? {},
      onProgress: (step) => options.onProgress?.("aad", step),
    });
    servicePlans = (entra["service_plans"] as unknown[]) ?? [];
    Object.assign(merged, entra);
    record("aad", tracker);
  } else if (wantsSecuritySuite) {
    options.onProgress?.("securitysuite", "licensing");
    const skus = await graph.list<{ ServicePlans?: unknown[] }>("/beta/subscribedSkus");
    servicePlans = skus.flatMap((sku) => sku.ServicePlans ?? []);
  }

  for (const product of options.products) {
    const tracker = new CommandTracker();
    const onProgress = (step: string) => options.onProgress?.(product, step);

    switch (product) {
      case "aad":
        continue; // already collected above
      case "exo":
        Object.assign(
          merged,
          await collectExchange({
            api, environment, tenantId: tenant.id, tracker,
            ...(options.dns ? { dns: options.dns } : {}),
            onProgress,
          }),
        );
        break;
      case "securitysuite":
      case "defender":
        Object.assign(
          merged,
          await collectSecuritySuite({ api, environment, tenantId: tenant.id, tracker, servicePlans, onProgress }),
        );
        break;
      case "sharepoint":
        Object.assign(
          merged,
          await collectSharePoint({ api, environment, tracker, domainPrefix: tenant.domainPrefix, onProgress }),
        );
        break;
      case "teams":
        Object.assign(merged, await collectTeams({ api, environment, tracker, onProgress }));
        break;
      case "powerplatform":
        Object.assign(
          merged,
          await collectPowerPlatform({ api, environment, tracker, tenantId: tenant.id, onProgress }),
        );
        break;
      case "powerbi":
        // The Power BI admin API needs a tenant setting that has to be turned on
        // per service principal, and ScubaGear reaches it through a separate
        // token audience. Not collected yet.
        tracker.skip("Get-PowerBITenantSettings", "Power BI collection is not implemented in SCuBAAnywhere yet.");
        break;
    }
    record(product, tracker);
  }

  merged["scuba_config"] = options.scubaConfig ?? {};
  return { export: merged, failedCollectors, failures };
}
