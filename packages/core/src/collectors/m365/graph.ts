import { ApiClient } from "../http.js";
import { endpointFor, type M365Environment } from "./endpoints.js";

interface GraphCollection<T> { value: T[]; "@odata.nextLink"?: string }

/**
 * Microsoft Graph, as the Rego expects to read it.
 *
 * Graph returns camelCase; ScubaGear's Rego reads PascalCase because the
 * PowerShell SDK capitalises on the way through (ConvertFrom-GraphHashtable).
 * `pascalize` reproduces that exactly, so the same Rego works unchanged.
 */
export class GraphClient {
  constructor(
    private readonly api: ApiClient,
    private readonly environment: M365Environment,
  ) {}

  private get endpoint() {
    return endpointFor("graph", this.environment);
  }

  /**
   * One resource.
   *
   * Errors are deliberately not swallowed. A 403 means the signed-in account
   * lacks the permission for this read, and treating that as "no data" would
   * hand the Rego an empty object and turn a blind spot into a passing policy.
   * Letting it throw lets the command tracker record the failure, which is what
   * makes the affected policies report as unevaluated.
   */
  async get<T = unknown>(path: string, headers?: Record<string, string>): Promise<T | null> {
    const options = { scope: this.endpoint.scope, corsSafe: this.endpoint.corsSafe };
    const body = await this.api.request<unknown>(this.url(path), headers ? { ...options, headers } : options);
    return body === null ? null : (pascalize(body) as T);
  }

  /** A collection, following @odata.nextLink to the end. */
  async list<T = Record<string, unknown>>(path: string, headers?: Record<string, string>): Promise<T[]> {
    const items: T[] = [];
    let url: string | undefined = this.url(path);
    while (url) {
      const options = { scope: this.endpoint.scope, corsSafe: this.endpoint.corsSafe };
      const page: GraphCollection<unknown> | null = await this.api.request<GraphCollection<unknown>>(
        url,
        headers ? { ...options, headers } : options,
      );
      if (!page) break;
      for (const item of page.value ?? []) items.push(pascalize(item) as T);
      url = page["@odata.nextLink"];
    }
    return items;
  }

  /** `$count` endpoints answer with a bare integer and need ConsistencyLevel. */
  async count(path: string): Promise<number | null> {
    const value = await this.api.request<number | string>(this.url(path), {
      scope: this.endpoint.scope,
      corsSafe: this.endpoint.corsSafe,
      headers: { ConsistencyLevel: "eventual", Accept: "text/plain" },
    });
    if (value === null) return null;
    const count = typeof value === "number" ? value : Number.parseInt(value, 10);
    return Number.isFinite(count) ? count : null;
  }

  private url(pathOrUrl: string): string {
    if (pathOrUrl.startsWith("http")) return pathOrUrl;
    return `${this.endpoint.baseUrl}${pathOrUrl}`;
  }
}

/**
 * Upper-case the first letter of every object key, recursively. Mirrors
 * ScubaGear's ConvertFrom-GraphHashtable so the Rego sees identical shapes.
 * Keys starting with `@` (OData annotations) are left alone.
 */
export function pascalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pascalize);
  if (value === null || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const renamed = key.startsWith("@") || key.length === 0 ? key : key[0]!.toUpperCase() + key.slice(1);
    out[renamed] = pascalize(nested);
  }
  return out;
}
