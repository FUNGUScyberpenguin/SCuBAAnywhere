import type { ReducedPolicies } from "../types.js";
import type { PolicyParser } from "./parser.js";

/**
 * Works out which apps a tenant's DLP rules actually protect.
 *
 * The baseline asks a narrow question: is there an active rule that detects
 * credit card numbers, SSNs and ITINs, alerts on them, and blocks the content
 * in Chat, Drive and Gmail. Answering it means reading Google's expression
 * language and a nest of per-app action settings, which is far easier here than
 * in Rego. The result is a list of apps in `dlp_pii` that the Rego checks.
 */
export class DlpRulesParser implements PolicyParser {
  constructor(private readonly policies: ReducedPolicies) {}

  parse(orgUnit: string, section: string): void {
    const orgPolicies = this.policies[orgUnit];
    if (!orgPolicies) return;

    const rules = orgPolicies[section];
    if (!Array.isArray(rules) || rules.length === 0) return;

    const byApp = new Map<string, Set<string>>();
    for (const rule of rules as Array<Record<string, unknown>>) {
      if (rule["state"] !== "ACTIVE" || !alertsEnabled(rule)) continue;

      const detectors = detectorsIn(rule);
      if (detectors.size === 0) continue;

      const apps = intersect(appsTriggering(rule), appsBlocking(rule));
      for (const app of apps) byApp.set(app, intersect(detectors, MINIMUM_DETECTORS));
    }

    const covered = [...byApp.entries()]
      .filter(([, detectors]) => sameMembers(detectors, MINIMUM_DETECTORS))
      .map(([app]) => app)
      .sort();

    orgPolicies["dlp_pii"] = covered;
  }
}

/** The detectors the baseline requires a rule to cover. */
const MINIMUM_DETECTORS = new Set([
  "CREDIT_CARD_NUMBER",
  "US_INDIVIDUAL_TAXPAYER_IDENTIFICATION_NUMBER",
  "US_SOCIAL_SECURITY_NUMBER",
]);

/** Likelihood levels, in Google's order. The baseline wants LIKELY or better. */
const LIKELIHOOD = ["VERY_UNLIKELY", "UNLIKELY", "POSSIBLE", "LIKELY", "VERY_LIKELY"];
const MINIMUM_LIKELIHOOD = LIKELIHOOD.indexOf("LIKELY");

// A condition term looks like:
//   all_content.matches_dlp_detector('US_SOCIAL_SECURITY_NUMBER',
//     google.privacy.dlp.v2.Likelihood.LIKELY,
//     {minimum_match_count: 1, minimum_unique_match_count: 1})
// Terms are joined with || and nothing else; anything more complicated is not
// something this can reason about, so it counts as no detector at all.
const TERM = /([a-z_]+)\.([a-z_]+)\(([^)]*\{[^}]*\}[^)]*|[^)]*)\)/i;
const OR = /\s*\|{2}\s*/;

function detectorsIn(rule: Record<string, unknown>): Set<string> {
  const found = new Set<string>();
  const condition = (rule["condition"] as { contentCondition?: unknown } | undefined)?.contentCondition;
  if (typeof condition !== "string") return found;

  for (const term of splitTerms(condition)) {
    const match = TERM.exec(term);
    if (!match || match.index !== 0) return new Set();

    const [, contentType, content, args] = match;
    const parsed = parseArguments(args ?? "");
    if (!parsed) continue;

    // The detector only counts when the rule looks at all content and is
    // matching a DLP detector, rather than, say, a file name.
    if (contentType !== "all_content" || content !== "matches_dlp_detector") continue;
    if (!MINIMUM_DETECTORS.has(parsed.detector)) continue;
    if (parsed.likelihood < MINIMUM_LIKELIHOOD) continue;
    if (parsed.minimumMatchCount !== 1 || parsed.minimumUniqueMatchCount !== 1) continue;

    found.add(parsed.detector);
  }
  return found;
}

function splitTerms(condition: string): string[] {
  return condition.trim().split(OR);
}

interface TermArguments {
  detector: string;
  likelihood: number;
  minimumMatchCount: number;
  minimumUniqueMatchCount: number;
}

/** Read the three arguments of a `matches_dlp_detector` call. */
function parseArguments(args: string): TermArguments | null {
  const detector = /^\s*['"]([^'"]+)['"]\s*,/.exec(args)?.[1];
  const likelihoodName = /Likelihood\.([A-Z_]+)/.exec(args)?.[1];
  const minimumMatchCount = numberField(args, "minimum_match_count");
  const minimumUniqueMatchCount = numberField(args, "minimum_unique_match_count");

  if (!detector || !likelihoodName || minimumMatchCount === null || minimumUniqueMatchCount === null) return null;
  const likelihood = LIKELIHOOD.indexOf(likelihoodName);
  if (likelihood === -1) return null;

  return { detector, likelihood, minimumMatchCount, minimumUniqueMatchCount };
}

function numberField(args: string, name: string): number | null {
  const value = new RegExp(`${name}\\s*:\\s*(\\d+)`).exec(args)?.[1];
  return value === undefined ? null : Number(value);
}

/** Alerting is on when `alertCenterConfig` exists, even if it is empty. */
function alertsEnabled(rule: Record<string, unknown>): boolean {
  const action = rule["action"] as Record<string, unknown> | undefined;
  const alert = action?.["alertCenterAction"] as Record<string, unknown> | undefined;
  return alert?.["alertCenterConfig"] !== undefined && alert["alertCenterConfig"] !== null;
}

/** An app counts only when every trigger the baseline expects is present. */
const REQUIRED_TRIGGERS: Record<string, Set<string>> = {
  chat: new Set(["attachment_upload", "message_send"]),
  drive: new Set(["file_share"]),
  gmail: new Set(["email_send"]),
};

const TRIGGER = /^google\.workspace\.(\w+)\.(\w+)\.\w+\.(\w+)$/;

function appsTriggering(rule: Record<string, unknown>): Set<string> {
  const triggers = rule["triggers"];
  const found = new Map<string, Set<string>>();
  if (!Array.isArray(triggers)) return new Set();

  for (const trigger of triggers as string[]) {
    const match = TRIGGER.exec(trigger);
    if (!match) continue;
    const [, app, type, action] = match;
    if (!app) continue;
    if (!found.has(app)) found.set(app, new Set());
    found.get(app)!.add(`${type}_${action}`);
  }

  const apps = new Set<string>();
  for (const [app, actions] of found) {
    const required = REQUIRED_TRIGGERS[app];
    if (required && sameMembers(actions, required)) apps.add(app);
  }
  return apps;
}

/**
 * Where each app's blocking configuration lives, and which flags must be on.
 * Drive has no flags, but the settings object still has to exist.
 */
const BLOCKING: Record<string, { path: string[]; flags: string[] | null }> = {
  chat: {
    path: ["blockContent", "actionParams"],
    flags: ["applyExternalDirectMessages", "applyExternalGroupChats", "applyExternalRooms"],
  },
  drive: { path: ["blockAccess"], flags: null },
  gmail: { path: ["blockContent", "actionParams"], flags: ["applyExternalMessages", "applyInternalMessages"] },
};

function appsBlocking(rule: Record<string, unknown>): Set<string> {
  const action = rule["action"] as Record<string, unknown> | undefined;
  const apps = new Set<string>();
  if (!action) return apps;

  for (const [app, spec] of Object.entries(BLOCKING)) {
    const appAction = action[`${app}Action`] as Record<string, unknown> | undefined;
    if (isBlocked(appAction, spec.path, spec.flags)) apps.add(app);
  }
  return apps;
}

function isBlocked(
  action: Record<string, unknown> | undefined,
  path: string[],
  flags: string[] | null,
): boolean {
  if (!action) return false;

  let node: unknown = action;
  for (const key of path) {
    if (typeof node !== "object" || node === null) return false;
    if (!(key in (node as Record<string, unknown>))) return false;
    node = (node as Record<string, unknown>)[key];
  }
  if (typeof node !== "object" || node === null) return false;
  if (flags === null) return true;

  const params = node as Record<string, unknown>;
  return flags.every((flag) => Boolean(params[flag]));
}

const intersect = <T>(a: Set<T>, b: Set<T>): Set<T> => new Set([...a].filter((item) => b.has(item)));

const sameMembers = <T>(a: Set<T>, b: Set<T>): boolean =>
  a.size === b.size && [...a].every((item) => b.has(item));
