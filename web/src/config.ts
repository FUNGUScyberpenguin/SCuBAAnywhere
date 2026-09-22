import type { M365Environment } from "@scubaanywhere/core";

/**
 * Deployment settings, fetched at startup from /config.json.
 *
 * Everything here is public. SCuBAAnywhere is a public OAuth client: it uses
 * the authorization code flow with PKCE and holds no client secret, because a
 * secret in a static web app is not a secret.
 */
export interface AppConfig {
  microsoft: {
    clientId: string;
    /** `organizations` for any work or school tenant, or a specific tenant id. */
    authority: string;
    environment: M365Environment;
  };
  /** Relay base URL. Empty means only Entra ID can be assessed live. */
  relayUrl: string;
  dns: {
    /** SPF, DKIM and DMARC checks send domain names to this resolver. */
    enabled: boolean;
    resolverUrl: string;
  };
}

const FALLBACK: AppConfig = {
  microsoft: { clientId: "", authority: "https://login.microsoftonline.com/organizations", environment: "commercial" },
  relayUrl: "",
  dns: { enabled: false, resolverUrl: "https://cloudflare-dns.com/dns-query" },
};

/**
 * Read config.json, or fall back to a configuration with live collection off.
 *
 * A static host that answers an unknown path with index.html will return 200
 * and a page of HTML here, so the content type is checked rather than trusted.
 * Missing configuration is not an error: the app still evaluates a settings
 * export, which needs no OAuth client at all.
 */
export async function loadConfig(): Promise<AppConfig> {
  try {
    const response = await fetch("config.json", { cache: "no-store" });
    if (!response.ok) return FALLBACK;
    if (!(response.headers.get("Content-Type") ?? "").includes("json")) return FALLBACK;

    const loaded = (await response.json()) as Partial<AppConfig>;
    return {
      microsoft: { ...FALLBACK.microsoft, ...loaded.microsoft },
      relayUrl: loaded.relayUrl ?? FALLBACK.relayUrl,
      dns: { ...FALLBACK.dns, ...loaded.dns },
    };
  } catch {
    return FALLBACK;
  }
}
