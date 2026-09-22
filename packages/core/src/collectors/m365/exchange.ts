import type { ProviderExport } from "../../types.js";
import type { ApiClient } from "../http.js";
import { dkimLookup, dmarcLookup, spfLookup, type DnsOptions, type TxtLookup } from "../dns.js";
import { CommandTracker } from "../tracker.js";
import { endpointFor, type M365Environment } from "./endpoints.js";

/**
 * Exchange Online and the Security Suite both answer through the same admin
 * REST API: POST an InvokeCommand endpoint with a cmdlet name and get JSON back.
 * ScubaGear drives them exactly this way, so the shapes match without
 * translation.
 *
 * Neither host sends CORS headers, so these calls go through the relay.
 */
export class AdminApiClient {
  constructor(
    private readonly api: ApiClient,
    private readonly endpoint: { baseUrl: string; scope: string; corsSafe: boolean },
    private readonly tenantId: string,
  ) {}

  async invoke<T = Record<string, unknown>>(cmdlet: string, parameters: Record<string, unknown> = {}): Promise<T[]> {
    const url = `${this.endpoint.baseUrl}/adminapi/beta/${this.tenantId}/InvokeCommand`;
    const response = await this.api.request<{ value?: T[] }>(url, {
      method: "POST",
      scope: this.endpoint.scope,
      corsSafe: this.endpoint.corsSafe,
      headers: { Prefer: "odata.maxpagesize=1000", "X-ResponseFormat": "json" },
      body: { CmdletInput: { CmdletName: cmdlet, Parameters: parameters } },
    });
    return response?.value ?? [];
  }
}

export interface ExchangeCollectionOptions {
  api: ApiClient;
  environment: M365Environment;
  tenantId: string;
  tracker: CommandTracker;
  /** Omit to skip the SPF/DKIM/DMARC checks entirely. */
  dns?: DnsOptions;
  onProgress?: (step: string) => void;
}

export async function collectExchange(options: ExchangeCollectionOptions): Promise<ProviderExport> {
  const { tracker } = options;
  const exo = new AdminApiClient(options.api, endpointFor("exchange", options.environment), options.tenantId);
  const cmdlet = <T>(name: string, fallback: T[] = [] as T[]) =>
    tracker.run(name, () => exo.invoke<T>(name), fallback);

  options.onProgress?.("Exchange Online configuration");
  const acceptedDomains = await cmdlet<{ DomainName?: string }>("Get-AcceptedDomain");

  const [
    remoteDomains, dkimConfig, transportConfig, sharingPolicy, transportRule,
    orgConfig, inboundConnectors, outboundConnectors, intraOrgConnectors, orgRelationships,
  ] = [
    await cmdlet("Get-RemoteDomain"),
    await cmdlet("Get-DkimSigningConfig"),
    await cmdlet("Get-TransportConfig"),
    await cmdlet("Get-SharingPolicy"),
    await cmdlet("Get-TransportRule"),
    await cmdlet("Get-OrganizationConfig"),
    await cmdlet("Get-InboundConnector"),
    await cmdlet("Get-OutboundConnector"),
    await cmdlet("Get-IntraOrganizationConnector"),
    await cmdlet("Get-OrganizationRelationship"),
  ];

  const domains = acceptedDomains.map((d) => d.DomainName).filter((d): d is string => Boolean(d));
  const dns = await collectDnsRecords(domains, tracker, options.dns, options.onProgress);

  return {
    remote_domains: remoteDomains,
    accepted_domains: acceptedDomains,
    dkim_config: dkimConfig,
    transport_config: transportConfig,
    sharing_policy: sharingPolicy,
    transport_rule: transportRule,
    org_config: orgConfig,
    inbound_connectors: inboundConnectors,
    outbound_connectors: outboundConnectors,
    intra_org_connectors: intraOrgConnectors,
    org_relationships: orgRelationships,
    ...dns,
    exo_successful_commands: tracker.successful,
    exo_unsuccessful_commands: tracker.unsuccessful,
  };
}

/** The SPF, DKIM and DMARC lookups the Exchange Online baseline needs. */
async function collectDnsRecords(
  domains: string[],
  tracker: CommandTracker,
  dns: DnsOptions | undefined,
  onProgress?: (step: string) => void,
) {
  if (!dns) {
    for (const command of ["Get-ScubaSpfRecord", "Get-ScubaDkimRecord", "Get-ScubaDmarcRecord"]) {
      tracker.skip(command, "DNS checks are turned off for this run.");
    }
    return { spf_records: [], dkim_records: [], dmarc_records: [] };
  }

  onProgress?.("DNS records");
  const shape = (lookup: TxtLookup) => ({
    domain: lookup.domain,
    rdata: lookup.rdata,
    log: lookup.error ? [{ query_method: "doh", query_result: lookup.error }] : [],
  });

  return {
    spf_records: await tracker.run(
      "Get-ScubaSpfRecord",
      async () => Promise.all(domains.map(async (d) => shape(await spfLookup(d, dns)))),
      [],
    ),
    dkim_records: await tracker.run(
      "Get-ScubaDkimRecord",
      async () => Promise.all(domains.map(async (d) => shape(await dkimLookup(d, dns)))),
      [],
    ),
    dmarc_records: await tracker.run(
      "Get-ScubaDmarcRecord",
      async () => Promise.all(domains.map(async (d) => shape(await dmarcLookup(d, dns)))),
      [],
    ),
  };
}

export interface SecuritySuiteCollectionOptions {
  api: ApiClient;
  environment: M365Environment;
  tenantId: string;
  tracker: CommandTracker;
  /** Service plans from the Entra collection; used for the licence checks. */
  servicePlans: unknown[];
  onProgress?: (step: string) => void;
}

export async function collectSecuritySuite(options: SecuritySuiteCollectionOptions): Promise<ProviderExport> {
  const { tracker } = options;
  const exo = new AdminApiClient(options.api, endpointFor("exchange", options.environment), options.tenantId);
  const scc = new AdminApiClient(options.api, endpointFor("compliance", options.environment), options.tenantId);

  type Row = Record<string, unknown>;
  const fromExo = (name: string) => tracker.run(name, () => exo.invoke<Row>(name), [] as Row[]);
  const fromScc = (name: string) => tracker.run(name, () => scc.invoke<Row>(name), [] as Row[]);

  options.onProgress?.("Defender and Security Suite policies");
  const adminAuditLogConfig = await fromExo("Get-AdminAuditLogConfig");
  const protectionPolicyRules = sortPolicies(await fromExo("Get-EOPProtectionPolicyRule"));
  const antiPhishPolicies = sortPolicies(await fromExo("Get-AntiPhishPolicy"));
  const antiPhishRules = sortPolicies(await fromExo("Get-AntiPhishRule"));
  const acceptedDomains = await fromExo("Get-AcceptedDomain");
  const connFilter = await fromExo("Get-HostedConnectionFilterPolicy");
  const safeLinksPolicies = sortPolicies(await fromExo("Get-SafeLinksPolicy"));
  const safeLinksRules = sortPolicies(await fromExo("Get-SafeLinksRule"));
  const hostedContentFilterPolicies = sortPolicies(await fromExo("Get-HostedContentFilterPolicy"));
  const hostedContentFilterRules = sortPolicies(await fromExo("Get-HostedContentFilterRule"));
  const antiMalwarePolicies = sortPolicies(await fromExo("Get-MalwareFilterPolicy"));
  const antiMalwareRules = sortPolicies(await fromExo("Get-MalwareFilterRule"));
  const safeAttachmentPolicies = sortPolicies(await fromExo("Get-SafeAttachmentPolicy"));
  const safeAttachmentRules = sortPolicies(await fromExo("Get-SafeAttachmentRule"));
  const builtInProtectionRules = await fromExo("Get-ATPBuiltInProtectionRule");

  // Defender for Office 365 endpoints answer with an error when the tenant is
  // not licensed for them. ScubaGear reads that as "unlicensed" rather than
  // "broken", and reports the licence-dependent policies accordingly.
  const atpPolicy = await fromExo("Get-AtpPolicyForO365");
  const atpProtectionPolicyRules = await fromExo("Get-ATPProtectionPolicyRule");
  const defenderLicense = !unsuccessful(tracker, ["Get-AtpPolicyForO365", "Get-ATPProtectionPolicyRule"]);
  if (!defenderLicense) clearFailures(tracker, ["Get-AtpPolicyForO365", "Get-ATPProtectionPolicyRule"]);

  const dlpPolicies = await fromScc("Get-DlpCompliancePolicy");
  const dlpRules = await fromScc("Get-DlpComplianceRule");
  const protectionAlerts = await fromScc("Get-ProtectionAlert");
  const dlpLicense = !unsuccessful(tracker, ["Get-DlpCompliancePolicy", "Get-DlpComplianceRule", "Get-ProtectionAlert"]);
  if (!dlpLicense) clearFailures(tracker, ["Get-DlpCompliancePolicy", "Get-DlpComplianceRule", "Get-ProtectionAlert"]);

  const unifiedAuditLogRetention = await fromScc("Get-UnifiedAuditLogRetentionPolicy");

  return {
    protection_policy_rules: protectionPolicyRules,
    atp_policy_rules: sortPolicies(defenderLicense ? atpProtectionPolicyRules : []),
    atp_policy_for_o365: sortPolicies(defenderLicense ? atpPolicy : []),
    dlp_compliance_policies: sortPolicies(dlpLicense ? dlpPolicies : []),
    dlp_compliance_rules: sortPolicies(dlpLicense ? dlpRules : []),
    anti_phish_policies: antiPhishPolicies,
    anti_phish_rules: antiPhishRules,
    safe_attachment_policies: safeAttachmentPolicies,
    safe_attachment_rules: safeAttachmentRules,
    built_in_protection_rules: builtInProtectionRules,
    accepted_domains: acceptedDomains,
    protection_alerts: dlpLicense ? protectionAlerts : [],
    admin_audit_log_config: adminAuditLogConfig,
    service_plans: options.servicePlans,
    unified_audit_log_retention_policies: unifiedAuditLogRetention,
    conn_filter: connFilter,
    safe_links_policies: safeLinksPolicies,
    safe_links_rules: safeLinksRules,
    defender_license: defenderLicense,
    defender_dlp_license: dlpLicense,
    hosted_content_filter_policies: hostedContentFilterPolicies,
    hosted_content_filter_rules: hostedContentFilterRules,
    anti_malware_policies: antiMalwarePolicies,
    anti_malware_rules: antiMalwareRules,
    securitysuite_successful_commands: tracker.successful,
    securitysuite_unsuccessful_commands: tracker.unsuccessful,
  };
}

const unsuccessful = (tracker: CommandTracker, commands: string[]) =>
  commands.some((command) => tracker.unsuccessful.includes(command));

/** Treat an unlicensed endpoint as answered, matching ScubaGear's reporting. */
function clearFailures(tracker: CommandTracker, commands: string[]): void {
  for (const command of commands) {
    const index = tracker.failures.findIndex((f) => f.command === command);
    if (index >= 0) tracker.failures.splice(index, 1);
    if (!tracker.successful.includes(command)) tracker.successful.push(command);
  }
}

/**
 * Preset policies do not follow the custom-policy priority convention, so Strict
 * then Standard come first and everything else sorts by priority. Same ordering
 * as ScubaGear's Format-SecuritySuitePolicyTable, which the Rego relies on.
 */
export function sortPolicies<T extends Record<string, unknown>>(policies: T[]): T[] {
  const presetRank = (policy: T) => {
    const name = String(policy["Name"] ?? policy["Identity"] ?? "");
    if (name.startsWith("Strict Preset Security Policy")) return 0;
    if (name.startsWith("Standard Preset Security Policy")) return 1;
    return 2;
  };
  const priority = (policy: T) => {
    const parsed = Number.parseInt(String(policy["Priority"] ?? ""), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return [...policies].sort((a, b) => presetRank(a) - presetRank(b) || priority(a) - priority(b));
}
