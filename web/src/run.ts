import {
  ApiClient, GraphClient, PolicyEngine, SUITES, assembleAssessment, collectM365, detectSuite,
  productsPresent, readTenantDetails,
  type Assessment, type BaselineDocument, type DnsOptions, type M365Product,
  type ProductEvaluation, type ProviderExport, type SuiteId,
} from "@scubaanywhere/core";
import type { AppConfig } from "./config.js";
import type { MicrosoftAuth } from "./auth/microsoft.js";
import type { Session } from "./session.js";

export const TOOL_VERSION = "0.1.0";

const baselines = new Map<SuiteId, Promise<BaselineDocument>>();
const engines = new Map<SuiteId, Promise<PolicyEngine>>();

function baselineFor(suite: SuiteId): Promise<BaselineDocument> {
  const existing = baselines.get(suite);
  if (existing) return existing;
  const loading = fetch(SUITES[suite].baselineUrl, { cache: "force-cache" }).then(async (response) => {
    if (!response.ok) {
      throw new Error(`Baseline for ${suite} is missing. Run \`npm run vendor && npm run baselines\` before building.`);
    }
    return (await response.json()) as BaselineDocument;
  });
  baselines.set(suite, loading);
  return loading;
}

function engineFor(suite: SuiteId): Promise<PolicyEngine> {
  const existing = engines.get(suite);
  if (existing) return existing;
  const loading = PolicyEngine.fromUrl(SUITES[suite].policyUrl).catch((error: unknown) => {
    engines.delete(suite);
    throw new Error(
      `Policy bundle for ${suite} is missing. Run \`npm run vendor && npm run policies\` before building.`,
      { cause: error },
    );
  });
  engines.set(suite, loading);
  return loading;
}

/**
 * Evaluate a settings export that is already in hand.
 *
 * Works for a file ScubaGear or ScubaGoggles produced as well as for one this
 * app just collected. The file is read in the browser with FileReader; it is
 * never uploaded.
 */
export async function evaluateSettings(
  settings: ProviderExport,
  options: { suite?: SuiteId; failedCollectors?: Record<string, string[]>; startedAt?: string },
): Promise<Assessment> {
  const suite = options.suite ?? detectSuite(settings);
  if (!suite) {
    throw new Error(
      "This does not look like a ScubaGear or ScubaGoggles settings export. " +
        "Expected a ProviderSettingsExport.json or the equivalent from ScubaGoggles.",
    );
  }

  const [engine, baseline] = await Promise.all([engineFor(suite), baselineFor(suite)]);
  const input = withBaselineVersions(settings, baseline);

  const evaluations: ProductEvaluation[] = [];
  for (const product of productsPresent(suite, settings)) {
    const failedCollectors = options.failedCollectors?.[product] ?? [];
    try {
      evaluations.push({ product, results: engine.evaluate(product, input), failedCollectors });
    } catch (error) {
      // One product failing to evaluate should not lose the other seven.
      evaluations.push({
        product,
        results: [],
        failedCollectors: [...failedCollectors, error instanceof Error ? error.message : String(error)],
      });
    }
  }

  return assembleAssessment({
    suite,
    target: targetOf(settings),
    startedAt: options.startedAt ?? new Date().toISOString(),
    toolVersion: TOOL_VERSION,
    baseline,
    upstreamCommit: baseline.source.commit,
    evaluations,
  });
}

/**
 * ScubaGoggles keeps policy id version suffixes in the baseline Markdown rather
 * than in the Rego, and passes them in as input. Without them every Google
 * policy id comes back as `...vM` and matches nothing in the baseline.
 */
function withBaselineVersions(settings: ProviderExport, baseline: BaselineDocument): ProviderExport {
  if (!baseline.versioning) return settings;
  return {
    ...settings,
    baseline_suffix: baseline.versioning.defaultSuffix,
    baseline_versions: baseline.versioning.overrides,
  };
}

/**
 * Name the tenant or organisation the export describes.
 *
 * ScubaGear writes `tenant_details` as an array of PascalCase objects, while a
 * run collected here writes a single camelCase object, and ScubaGoggles writes
 * `tenant_info`. All three show up as uploads, so all three are read.
 */
function targetOf(settings: ProviderExport): Assessment["target"] {
  const details = settings["tenant_details"];
  const tenant = (Array.isArray(details) ? details[0] : details) as
    | { id?: string; displayName?: string; TenantId?: string; DisplayName?: string; DomainName?: string }
    | undefined;

  const id = tenant?.id ?? tenant?.TenantId;
  if (id) {
    const target: Assessment["target"] = { id, displayName: tenant?.displayName ?? tenant?.DisplayName ?? id };
    if (tenant?.DomainName) target.domain = tenant.DomainName;
    return target;
  }

  const info = settings["tenant_info"] as { topLevelOU?: string; domain?: string } | undefined;
  if (info?.topLevelOU) {
    const target: Assessment["target"] = { id: info.topLevelOU, displayName: info.topLevelOU };
    if (info.domain) target.domain = info.domain;
    return target;
  }
  return { id: "unknown", displayName: "Unknown organisation" };
}

export interface LiveRunOptions {
  config: AppConfig;
  auth: MicrosoftAuth;
  session: Session;
  products: M365Product[];
  signal?: AbortSignal;
}

/** Collect from a live Microsoft 365 tenant, then evaluate what came back. */
export async function runMicrosoft365(options: LiveRunOptions): Promise<Assessment> {
  const { config, auth, session } = options;
  const startedAt = new Date().toISOString();

  const api = new ApiClient({
    getToken: (scope) => auth.getToken(scope),
    ...(config.relayUrl ? { relayUrl: config.relayUrl } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  session.log("info", "Reading tenant details from Microsoft Graph");
  const tenant = await readTenantDetails(new GraphClient(api, config.microsoft.environment));
  session.update({ tenant: { id: tenant.id, displayName: tenant.displayName } });
  session.log("info", `Assessing ${tenant.displayName} (${tenant.initialDomain || tenant.id})`);

  const dns: DnsOptions | undefined = config.dns.enabled
    ? { resolverUrl: config.dns.resolverUrl, ...(options.signal ? { signal: options.signal } : {}) }
    : undefined;
  if (!dns) session.log("warn", "DNS checks are off, so the SPF, DKIM and DMARC policies will not be evaluated");

  const collection = await collectM365({
    api,
    environment: config.microsoft.environment,
    products: options.products,
    tenant,
    ...(dns ? { dns } : {}),
    onProgress: (product, step) => session.log("info", `${product}: ${step}`),
  });

  for (const [command, message] of Object.entries(collection.failures)) {
    session.log("warn", `${command} did not return: ${message}`);
  }

  session.update({ settings: collection.export });
  session.log("info", "Evaluating the baselines in this browser");
  return evaluateSettings(collection.export, {
    suite: "m365",
    failedCollectors: collection.failedCollectors,
    startedAt,
  });
}
