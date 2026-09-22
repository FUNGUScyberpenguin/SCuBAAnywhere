/**
 * The only destinations the relay will forward to.
 *
 * The relay exists because Microsoft's admin APIs do not send CORS headers, so
 * a browser cannot call them directly. That makes it an open proxy unless it is
 * pinned down, so every destination is matched against this list: exact host,
 * https only, and a path prefix. Anything else is refused.
 */
export interface AllowedHost {
  host: string;
  /** Request path must start with one of these. */
  prefixes: string[];
}

/** Hosts with a fixed name. */
const FIXED: AllowedHost[] = [
  // Exchange Online admin API (Exchange Online and Security Suite baselines).
  { host: "outlook.office365.com", prefixes: ["/adminapi/"] },
  { host: "outlook.office365.us", prefixes: ["/adminapi/"] },
  { host: "outlook-dod.office365.us", prefixes: ["/adminapi/"] },
  // Security and Compliance admin API.
  { host: "ps.compliance.protection.outlook.com", prefixes: ["/adminapi/"] },
  { host: "ps.compliance.protection.office365.us", prefixes: ["/adminapi/"] },
  // Teams admin API.
  { host: "api.interfaces.records.teams.microsoft.com", prefixes: ["/Skype.Policy/", "/AdminAppCatalog/"] },
  { host: "api.interfaces.records.gov.teams.microsoft.us", prefixes: ["/Skype.Policy/", "/AdminAppCatalog/"] },
  // Power Platform admin API.
  { host: "api.bap.microsoft.com", prefixes: ["/providers/"] },
  { host: "gov.api.bap.microsoft.us", prefixes: ["/providers/"] },
  { host: "high.api.bap.microsoft.us", prefixes: ["/providers/"] },
  { host: "api.appsplatform.us", prefixes: ["/providers/"] },
];

/**
 * SharePoint's admin host carries the tenant name, so it is matched by pattern.
 * The tenant prefix is restricted to the characters a SharePoint domain can
 * actually contain, which keeps the pattern from matching a lookalike domain.
 */
const SHAREPOINT = /^[a-z0-9][a-z0-9-]{0,62}-admin\.sharepoint\.(com|us)$|^[a-z0-9][a-z0-9-]{0,62}-admin\.sharepoint-mil\.us$/;
const SHAREPOINT_PREFIXES = ["/_api/"];

export interface AllowDecision {
  allowed: boolean;
  /** Why it was refused. Safe to return to the caller; names no user data. */
  reason?: string;
}

export function checkTarget(rawTarget: string): AllowDecision {
  let url: URL;
  try {
    url = new URL(rawTarget);
  } catch {
    return { allowed: false, reason: "target is not a URL" };
  }

  if (url.protocol !== "https:") return { allowed: false, reason: "target must be https" };
  if (url.username || url.password) return { allowed: false, reason: "target must not carry credentials" };
  if (url.port && url.port !== "443") return { allowed: false, reason: "target must use the default https port" };

  const host = url.hostname.toLowerCase();
  const prefixes = SHAREPOINT.test(host) ? SHAREPOINT_PREFIXES : FIXED.find((h) => h.host === host)?.prefixes;
  if (!prefixes) return { allowed: false, reason: `host ${host} is not on the relay's allowlist` };

  if (!prefixes.some((prefix) => url.pathname.startsWith(prefix))) {
    return { allowed: false, reason: `path is not allowed on ${host}` };
  }
  return { allowed: true };
}

/** Every fixed host, for operators who want to pre-approve egress. */
export const ALLOWED_HOSTS: readonly string[] = FIXED.map((h) => h.host);
