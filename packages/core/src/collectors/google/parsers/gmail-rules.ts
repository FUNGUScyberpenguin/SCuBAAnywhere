import type { OrgUnitPolicies, ReducedPolicies } from "../types.js";
import type { PolicyParser } from "./parser.js";

interface AddressList {
  name: string;
  list: string[];
}

const SPAM_OVERRIDE = "gmail_spam_override_lists";
const BLOCKED_SENDERS = "gmail_blocked_sender_lists";

const SECTION_FIELDS: Record<string, { setting: string; fields: string[] }> = {
  [SPAM_OVERRIDE]: { setting: "spamOverride", fields: ["bypassSenderAllowlist", "hideWarningBannerSenderAllowlist"] },
  [BLOCKED_SENDERS]: { setting: "blockedSenders", fields: ["senderBlocklist", "bypassApprovedSenderAllowlist"] },
};

/** An entry with no `@` but at least one dot is a domain, not an address. */
const DOMAIN = /^[^@]+\.[^@]+$/;

/**
 * Flattens Gmail's blocked-sender and spam-override lists.
 *
 * Google returns each rule holding a list of ids that reference other lists of
 * email addresses, one indirection deeper than Rego can read comfortably. This
 * replaces each id with the addresses it points at, drops rules that are turned
 * off, and marks any allow list that contains a whole domain where the baseline
 * expects individual addresses.
 */
export class GmailRulesParser implements PolicyParser {
  private readonly addressLists: Map<string, AddressList>;

  constructor(
    private readonly policies: ReducedPolicies,
    topOrgUnit: string,
  ) {
    this.addressLists = buildAddressLists(this.policies[topOrgUnit]);
  }

  parse(orgUnit: string, section: string): void {
    const orgPolicies = this.policies[orgUnit];
    if (!orgPolicies) return;

    const sectionData = orgPolicies[section] as Record<string, unknown> | undefined;
    // The only way there is no data here is the top org unit having no
    // settings for the section at all.
    if (!sectionData) return;

    const fields = SECTION_FIELDS[section];
    if (!fields) return;

    const enabled = enabledRuleIds(orgPolicies);
    const rules = sectionData[fields.setting];
    if (!Array.isArray(rules)) return;

    // Walked backwards so a disabled rule can be removed as it is found.
    for (let index = rules.length - 1; index >= 0; index -= 1) {
      const rule = rules[index] as Record<string, unknown>;
      const ruleId = String(rule["ruleId"] ?? "");
      if (!enabled.has(ruleId)) {
        rules.splice(index, 1);
        continue;
      }
      for (const field of fields.fields) {
        if (!(field in rule)) continue;
        const ids = rule[field];
        if (!Array.isArray(ids)) continue;
        rule[field] = ids.map((id) => this.addressLists.get(String(id)) ?? { name: "", list: [] });
      }
    }

    if (section === SPAM_OVERRIDE) markDomainsInAllowLists(sectionData);
  }
}

/**
 * Map every address list to its contents, taken from the top org unit. A list
 * whose rule is turned off resolves to no addresses rather than being absent,
 * so the Rego does not have to tell "off" from "missing".
 */
function buildAddressLists(topPolicies: OrgUnitPolicies | undefined): Map<string, AddressList> {
  const lists = new Map<string, AddressList>();
  if (!topPolicies) return lists;

  const section = topPolicies["gmail_email_address_lists"] as Record<string, unknown> | undefined;
  if (!section) return lists;

  const enabled = enabledRuleIds(topPolicies);
  const entries = section["emailAddressList"];
  if (!Array.isArray(entries)) return lists;

  for (const entry of entries as Array<Record<string, unknown>>) {
    const ruleId = String(entry["id"] ?? "");
    const addressList = (entry["addressList"] ?? entry["blockedAddressList"]) as
      | { address?: Array<{ address?: string }> }
      | undefined;
    const addresses = enabled.has(ruleId)
      ? (addressList?.address ?? []).map((item) => String(item.address ?? ""))
      : [];
    lists.set(ruleId, { name: String(entry["name"] ?? ""), list: addresses });
  }
  return lists;
}

/** Rule ids the org unit has switched on. */
function enabledRuleIds(orgPolicies: OrgUnitPolicies): Set<string> {
  const section = orgPolicies["gmail_rule_states"] as { ruleStates?: unknown } | undefined;
  const states = section?.ruleStates;
  if (!Array.isArray(states)) return new Set();
  return new Set(
    (states as Array<Record<string, unknown>>)
      .filter((state) => state["enabled"])
      .map((state) => String(state["ruleId"] ?? "")),
  );
}

/**
 * Record any allow list that contains a domain rather than an address.
 *
 * The baseline requires these lists to name individual senders; a domain
 * exempts everyone at it. Finding them here, where the nesting is already
 * flattened, is far easier than doing it in Rego, so the Rego only has to check
 * whether the attribute is present.
 */
function markDomainsInAllowLists(sectionData: Record<string, unknown>): void {
  const checks = [
    { allowList: "hideWarningBannerSenderAllowlist", attribute: "warningDomainsFound" },
    { allowList: "bypassSenderAllowlist", attribute: "senderDomainsFound" },
  ];

  const overrides = Array.isArray(sectionData["spamOverride"])
    ? (sectionData["spamOverride"] as Array<Record<string, unknown>>)
    : [];

  for (const { allowList, attribute } of checks) {
    const findings: string[] = [];

    for (const override of overrides) {
      const lists = Array.isArray(override[allowList]) ? (override[allowList] as AddressList[]) : [];
      const perList: string[] = [];

      for (const list of lists) {
        const domains = (list.list ?? []).filter((entry) => DOMAIN.test(entry)).join(", ");
        if (domains) perList.push(`${list.name}: (${domains})`);
      }
      if (perList.length > 0) findings.push(`{${String(override["description"] ?? "")}: [${perList.join(", ")}]}`);
    }

    if (findings.length > 0) sectionData[attribute] = findings.join(", ");
  }
}
