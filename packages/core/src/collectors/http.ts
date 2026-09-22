import type { Transport } from "../types.js";

export interface ApiClientOptions {
  /** Mints an access token for an OAuth scope. Tokens stay in memory. */
  getToken: (scope: string) => Promise<string>;
  /**
   * Base URL of the relay, for hosts that do not send CORS headers. Without it,
   * only Microsoft Graph and the Google APIs are reachable from a browser.
   */
  relayUrl?: string;
  fetchImpl?: Transport;
  signal?: AbortSignal;
  /** Called on every request, so the UI can show progress. */
  onRequest?: (method: string, url: string) => void;
}

export interface RequestOptions {
  method?: string;
  scope: string;
  /** False routes the request through the relay. */
  corsSafe: boolean;
  headers?: Record<string, string>;
  body?: unknown;
  /** Treat these HTTP statuses as an empty result rather than an error. */
  emptyOn?: number[];
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly url: string, readonly body: string) {
    super(`HTTP ${status} from ${redactUrl(url)}`);
    this.name = "HttpError";
  }
}

/** Strip query strings from anything that reaches a log or an error message. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<malformed url>";
  }
}

const RETRYABLE = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

/**
 * Talks to an admin API on the operator's behalf.
 *
 * Direct when the host allows a browser origin, through the relay when it does
 * not. Either way the bearer token is minted here and the response body is only
 * ever held in memory.
 */
export class ApiClient {
  private readonly fetchImpl: Transport;

  constructor(private readonly options: ApiClientOptions) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  async request<T>(url: string, options: RequestOptions): Promise<T | null> {
    const method = options.method ?? "GET";
    const token = await this.options.getToken(options.scope);
    const target = options.corsSafe ? url : this.viaRelay(url);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...options.headers,
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    this.options.onRequest?.(method, url);

    for (let attempt = 1; ; attempt += 1) {
      const init: RequestInit = { method, headers };
      if (options.body !== undefined) init.body = JSON.stringify(options.body);
      if (this.options.signal) init.signal = this.options.signal;

      const response = await this.fetchImpl(target, init);
      if (response.ok) {
        if (response.status === 204) return null;
        const text = await response.text();
        return text ? (JSON.parse(text) as T) : null;
      }
      if (options.emptyOn?.includes(response.status)) return null;

      if (RETRYABLE.has(response.status) && attempt < MAX_ATTEMPTS) {
        await delay(retryDelayMs(response, attempt));
        continue;
      }
      throw new HttpError(response.status, url, (await response.text()).slice(0, 2000));
    }
  }

  private viaRelay(url: string): string {
    if (!this.options.relayUrl) {
      throw new Error(
        `${redactUrl(url)} does not accept browser requests, and no relay is configured. ` +
          `Set the relay URL, or deselect the products that need it.`,
      );
    }
    return `${this.options.relayUrl.replace(/\/+$/, "")}/v1/forward?target=${encodeURIComponent(url)}`;
  }
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get("Retry-After"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 60_000);
  return Math.min(2 ** attempt * 500, 16_000);
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
