import { loadPolicy } from "@open-policy-agent/opa-wasm";
import { REGO_BUILTINS } from "./builtins.js";
import type { PolicyResult, ProductId, ProviderExport } from "../types.js";

interface LoadedPolicy {
  setData(data: unknown): void;
  evaluate(input: unknown, entrypoint?: string): Array<{ result: unknown }>;
}

/**
 * Runs CISA's Rego baselines, compiled to WebAssembly, in the current process.
 *
 * The evaluation happens where the configuration data already is: in the
 * operator's browser tab. No settings export and no result ever crosses a
 * network boundary to be assessed.
 */
export class PolicyEngine {
  private constructor(private readonly policy: LoadedPolicy) {}

  static async load(wasm: ArrayBuffer | Uint8Array, data: unknown = {}): Promise<PolicyEngine> {
    const policy = (await loadPolicy(wasm, undefined, REGO_BUILTINS)) as unknown as LoadedPolicy;
    policy.setData(data);
    return new PolicyEngine(policy);
  }

  /** Fetch a bundle produced by `npm run policies` and load it. */
  static async fromUrl(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<PolicyEngine> {
    const [wasmRes, dataRes] = await Promise.all([
      fetchImpl(`${baseUrl}/policy.wasm`),
      fetchImpl(`${baseUrl}/data.json`),
    ]);
    if (!wasmRes.ok) throw new Error(`policy bundle ${baseUrl}/policy.wasm: HTTP ${wasmRes.status}`);
    if (!dataRes.ok) throw new Error(`policy bundle ${baseUrl}/data.json: HTTP ${dataRes.status}`);
    return PolicyEngine.load(await wasmRes.arrayBuffer(), await dataRes.json());
  }

  /**
   * Evaluate one product's baseline. The entrypoint is `data.<product>.tests`,
   * the same one ScubaGear and ScubaGoggles evaluate with the OPA binary.
   */
  evaluate(product: ProductId, input: ProviderExport): PolicyResult[] {
    let output: Array<{ result: unknown }>;
    try {
      output = this.policy.evaluate(input, `${product}/tests`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String((cause as { message?: string })?.message ?? cause);
      if (message.includes("not implemented: built-in function")) {
        throw new Error(
          `${product}: the policy bundle needs a Rego built-in the runtime does not provide (${message}). ` +
            `Add it to packages/core/src/opa/builtins.ts.`,
          { cause },
        );
      }
      throw new Error(`${product}: policy evaluation failed: ${message}`, { cause });
    }

    const result = output[0]?.result;
    if (!Array.isArray(result)) {
      throw new Error(`${product}: expected an array of policy results, got ${typeof result}`);
    }
    return result as PolicyResult[];
  }
}
