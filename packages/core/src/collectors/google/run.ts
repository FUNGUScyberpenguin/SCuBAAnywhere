import type { GwsProduct, ProviderExport } from "../../types.js";
import type { ApiClient } from "../http.js";
import type { DnsOptions } from "../dns.js";
import { dmarcLookup, lookupTxt, spfLookup } from "../dns.js";
import { CommandTracker } from "../tracker.js";
import { CLOUD_IDENTITY, GOOGLE_API_CALLS, GoogleApiClient } from "./api.js";
import {
  DirectoryCollector, collectInboundSso, groupMap, orgUnitMap, topLevelOrgUnit,
  type Domain,
} from "./directory.js";
import { collectPrivilegedUsers, superAdmins } from "./privileged.js";
import { collectActivityLogs } from "./reports.js";
import { PolicyReducer } from "./policy-api.js";
import type { PolicyTables } from "./tables.js";
import type { RawPolicy } from "./types.js";

/**
 * DKIM selectors to probe, in order. Google offers no API for the selectors in
 * use, so ScubaGoggles tries the common ones; a tenant using a different
 * selector will look as though it has no DKIM record.
 */
const DKIM_SELECTORS = ["google", "selector1", "selector2"];

export interface GwsRunOptions {
  api: ApiClient;
  /** `my_customer` works for the signed-in admin's own tenant. */
  customerId?: string;
  products: GwsProduct[];
  tables: PolicyTables;
  /** Omit to skip the SPF, DKIM and DMARC checks. */
  dns?: DnsOptions;
  /** Accounts the operator has declared as break-glass, from their config. */
  breakGlassAccounts?: string[];
  onProgress?: (step: string) => void;
}

export interface GwsCollection {
  export: ProviderExport;
  failedCollectors: Record<string, string[]>;
  failures: Record<string, string>;
  organisation: { id: string; displayName: string; domain?: string };
}

/**
 * Collect a Google Workspace organisation's configuration.
 *
 * Everything here is a browser-direct call: Google's APIs send CORS headers, so
 * unlike the Microsoft side there is no relay on the path and the configuration
 * never touches a third machine.
 */
export async function collectGoogleWorkspace(options: GwsRunOptions): Promise<GwsCollection> {
  const tracker = new CommandTracker();
  const google = new GoogleApiClient(options.api);
  const customerId = options.customerId ?? "my_customer";
  const directory = new DirectoryCollector(google, customerId, tracker);
  const step = (name: string) => options.onProgress?.(name);

  step("organizational units");
  const orgUnits = await directory.orgUnits();
  const topOrgUnit = topLevelOrgUnit(orgUnits);
  if (!topOrgUnit) {
    throw new Error(
      "Could not read the top-level organizational unit. Check that the signed-in account is a Google " +
        "Workspace admin and that the Admin SDK API is enabled for the project.",
    );
  }

  step("groups");
  const groups = await directory.groups();

  step("policies");
  const policies = await tracker.run(
    // The Policy API has no ScubaGoggles call name of its own; it is the one
    // collector whose failure means no policy can be evaluated at all.
    "cloudidentity/v1/policies/list",
    () => google.list<RawPolicy>(`${CLOUD_IDENTITY}/v1/policies`, "policies"),
    [],
  );

  step("reducing policies");
  const reducer = new PolicyReducer(options.tables, topOrgUnit, orgUnitMap(orgUnits), groupMap(groups));
  const reduced = reducer.reduce(policies);

  step("admin audit log");
  const logs = await collectActivityLogs(google, options.products, tracker, (event) =>
    step(`admin audit log: ${event}`),
  );

  const orgUnitNames = ["", topOrgUnit, ...orgUnits.map((orgUnit) => orgUnit.name)];

  const collected: ProviderExport = {
    policies: reduced,
    organizational_units: { organizationUnits: orgUnits },
    organizational_unit_names: [...new Set(orgUnitNames)],
    ...logs,
    break_glass_accounts: options.breakGlassAccounts ?? [],
  };

  // Common Controls is the one baseline that reads beyond the Policy API.
  if (options.products.includes("commoncontrols")) {
    step("administrators");
    const users = await directory.users();
    Object.assign(collected, { super_admins: superAdmins(users) });
    Object.assign(collected, await collectPrivilegedUsers(google, customerId, users, tracker));

    step("single sign-on");
    const canonical = await directory.canonicalCustomerId();
    Object.assign(collected, await collectInboundSso(google, canonical, tracker));
  }

  step("domains");
  const domains = await directory.domains();
  const aliases = await directory.aliasDomains();
  Object.assign(collected, await collectDns(domains, aliases, options.dns, tracker, step));

  const tenantInfo = await readTenantInfo(google, customerId, topOrgUnit, domains, tracker);
  collected["tenant_info"] = tenantInfo;
  collected["successful_calls"] = [...new Set(tracker.successful)];
  collected["unsuccessful_calls"] = [...new Set(tracker.unsuccessful)];
  // Only ScubaGoggles' own report front page uses this, never the policies.
  collected["missing_policies"] = [];

  const failures: Record<string, string> = {};
  for (const failure of tracker.failures) failures[failure.command] = failure.message;

  const organisation: GwsCollection["organisation"] = {
    id: String(tenantInfo["ID"] ?? topOrgUnit),
    displayName: topOrgUnit,
  };
  const domain = tenantInfo["domain"];
  if (typeof domain === "string" && domain) organisation.domain = domain;

  return {
    export: collected,
    // Every Google product is evaluated from the same collection, so a failed
    // collector affects all of them.
    failedCollectors: Object.fromEntries(options.products.map((product) => [product, tracker.unsuccessful])),
    failures,
    organisation,
  };
}

async function readTenantInfo(
  google: GoogleApiClient,
  customerId: string,
  topOrgUnit: string,
  domains: Domain[],
  tracker: CommandTracker,
): Promise<Record<string, unknown>> {
  const primary = domains.find((domain) => domain.isPrimary)?.domainName ?? "Error Retrieving";
  const id = await tracker.run(
    GOOGLE_API_CALLS.getCustomer,
    async () => {
      const customer = await google.get<{ id?: string }>(
        `https://admin.googleapis.com/admin/directory/v1/customers/${encodeURIComponent(customerId)}`,
      );
      return customer?.id ?? "";
    },
    "",
  );
  return { ID: id, domain: primary, topLevelOU: topOrgUnit };
}

/** SPF, DKIM and DMARC lookups for the Gmail baseline. */
async function collectDns(
  domains: Domain[],
  aliases: Array<{ domainAliasName: string; verified?: boolean }>,
  dns: DnsOptions | undefined,
  tracker: CommandTracker,
  step: (name: string) => void,
): Promise<ProviderExport> {
  const baseDomains = domains.filter((d) => d.verified !== false).map((d) => d.domainName);
  const aliasDomains = aliases.filter((d) => d.verified !== false).map((d) => d.domainAliasName);
  const allDomains = [...new Set([...baseDomains, ...aliasDomains])];

  if (!dns) {
    tracker.skip("dns/spf", "DNS checks are turned off for this run.");
    tracker.skip("dns/dkim", "DNS checks are turned off for this run.");
    tracker.skip("dns/dmarc", "DNS checks are turned off for this run.");
    return {
      domains: baseDomains,
      alias_domains: aliasDomains,
      spf_records: [],
      dkim_records: [],
      dmarc_records: [],
    };
  }

  step("DNS records");
  const shape = (domain: string, rdata: string[], error?: string) => ({
    domain,
    rdata,
    log: error ? [{ query_method: "doh", query_result: error }] : [],
  });

  const spf = await tracker.run(
    "dns/spf",
    async () =>
      Promise.all(
        baseDomains.map(async (domain) => {
          const result = await spfLookup(domain, dns);
          return shape(domain, result.rdata, result.error);
        }),
      ),
    [],
  );

  const dkim = await tracker.run(
    "dns/dkim",
    async () =>
      Promise.all(
        baseDomains.map(async (domain) => {
          for (const selector of DKIM_SELECTORS) {
            const result = await lookupTxt(`${selector}._domainkey.${domain}`, dns);
            if (result.rdata.length > 0) return shape(domain, result.rdata);
          }
          return shape(domain, [], "no DKIM record found for the selectors tried");
        }),
      ),
    [],
  );

  const dmarc = await tracker.run(
    "dns/dmarc",
    async () =>
      Promise.all(
        allDomains.map(async (domain) => {
          const result = await dmarcLookup(domain, dns);
          if (result.rdata.length > 0) return shape(domain, result.rdata);
          // DMARC is inherited from the organisational domain, so a subdomain
          // with no record of its own is checked against its parent.
          const labels = domain.split(".");
          if (labels.length < 3) return shape(domain, [], result.error ?? "no DMARC record");
          const organisational = labels.slice(-2).join(".");
          const parent = await dmarcLookup(organisational, dns);
          return shape(domain, parent.rdata, parent.rdata.length > 0 ? undefined : parent.error);
        }),
      ),
    [],
  );

  return {
    domains: baseDomains,
    alias_domains: aliasDomains,
    spf_records: spf,
    dkim_records: dkim,
    dmarc_records: dmarc,
  };
}
