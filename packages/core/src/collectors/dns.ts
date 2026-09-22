import type { Transport } from "../types.js";

/**
 * TXT lookups for the SPF, DKIM and DMARC checks in the Exchange Online
 * baseline, over DNS-over-HTTPS so they work from a browser.
 *
 * This is the one collector that talks to a third party. The resolver learns
 * which domains were queried, which is a disclosure worth making before a run
 * rather than after, so the resolver is a caller-supplied setting and DNS
 * checks can be turned off entirely.
 */
export interface DnsOptions {
  /** A DoH endpoint that answers the JSON API, e.g. Cloudflare or Google. */
  resolverUrl: string;
  fetchImpl?: Transport;
  signal?: AbortSignal;
}

export interface TxtLookup {
  domain: string;
  rdata: string[];
  /** Present when the lookup failed or the name does not exist. */
  error?: string;
}

interface DohAnswer { name: string; type: number; data: string }
interface DohResponse { Status: number; Answer?: DohAnswer[] }

const TXT = 16;

export async function lookupTxt(name: string, options: DnsOptions): Promise<TxtLookup> {
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const url = `${options.resolverUrl}?name=${encodeURIComponent(name)}&type=TXT`;
  try {
    const init: RequestInit = { method: "GET", headers: { Accept: "application/dns-json" } };
    if (options.signal) init.signal = options.signal;
    const response = await fetchImpl(url, init);
    if (!response.ok) return { domain: name, rdata: [], error: `resolver returned HTTP ${response.status}` };

    const body = (await response.json()) as DohResponse;
    if (body.Status === 3) return { domain: name, rdata: [], error: "NXDOMAIN" };
    if (body.Status !== 0) return { domain: name, rdata: [], error: `resolver status ${body.Status}` };

    const rdata = (body.Answer ?? [])
      .filter((answer) => answer.type === TXT)
      // The JSON API returns TXT strings quoted, and splits long records.
      .map((answer) => answer.data.replace(/"\s+"/g, "").replace(/^"|"$/g, ""));
    return { domain: name, rdata };
  } catch (error) {
    return { domain: name, rdata: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export const spfLookup = (domain: string, options: DnsOptions) => lookupTxt(domain, options);
export const dmarcLookup = (domain: string, options: DnsOptions) => lookupTxt(`_dmarc.${domain}`, options);

/** DKIM selectors ScubaGear probes, in the order it tries them. */
export const DKIM_SELECTORS = ["selector1", "selector2"] as const;

export async function dkimLookup(domain: string, options: DnsOptions): Promise<TxtLookup> {
  const attempts: TxtLookup[] = [];
  for (const selector of DKIM_SELECTORS) {
    const result = await lookupTxt(`${selector}._domainkey.${domain}`, options);
    if (result.rdata.length > 0) return result;
    attempts.push(result);
  }
  return attempts[0] ?? { domain, rdata: [], error: "no selector answered" };
}
