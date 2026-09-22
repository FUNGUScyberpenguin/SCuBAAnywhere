import { GWS_PRODUCTS, M365_PRODUCTS, type ProductId, type SuiteId } from "./types.js";

/** Which baselines a settings export belongs to, and how to label it. */
export interface SuiteDescriptor {
  id: SuiteId;
  label: string;
  upstream: string;
  products: readonly ProductId[];
  /** Where the built WASM bundle and normalised baseline live. */
  policyUrl: string;
  baselineUrl: string;
}

export const SUITES: Record<SuiteId, SuiteDescriptor> = {
  m365: {
    id: "m365",
    label: "Microsoft 365",
    upstream: "cisagov/ScubaGear",
    products: M365_PRODUCTS,
    policyUrl: "policies/m365",
    baselineUrl: "baselines/m365.json",
  },
  gws: {
    id: "gws",
    label: "Google Workspace",
    upstream: "cisagov/ScubaGoggles",
    products: GWS_PRODUCTS,
    policyUrl: "policies/gws",
    baselineUrl: "baselines/gws.json",
  },
};

export const PRODUCT_LABELS: Record<ProductId, string> = {
  aad: "Entra ID",
  defender: "Defender for Office 365",
  exo: "Exchange Online",
  powerbi: "Power BI",
  powerplatform: "Power Platform",
  securitysuite: "Security Suite",
  sharepoint: "SharePoint and OneDrive",
  teams: "Teams",
  assuredcontrols: "Assured Controls",
  calendar: "Calendar",
  chat: "Chat",
  classroom: "Classroom",
  commoncontrols: "Common Controls",
  drive: "Drive and Docs",
  gemini: "Gemini",
  gmail: "Gmail",
  groups: "Groups for Business",
  meet: "Meet",
  sites: "Sites",
};

/**
 * Work out which suite a settings export came from.
 *
 * ScubaGear exports carry product-specific command lists; ScubaGoggles exports
 * carry a `policies` map keyed by org unit. Neither file records its own origin,
 * so the shape is the only signal available.
 */
export function detectSuite(settings: Record<string, unknown>): SuiteId | null {
  const keys = new Set(Object.keys(settings));
  if (keys.has("conditional_access_policies") || keys.has("aad_successful_commands")) return "m365";
  if ([...keys].some((key) => key.endsWith("_successful_commands") && key !== "successful_commands")) return "m365";
  if (keys.has("policies") && keys.has("tenant_info")) return "gws";
  return null;
}

/** Products a settings export actually contains data for. */
export function productsPresent(suite: SuiteId, settings: Record<string, unknown>): ProductId[] {
  if (suite === "gws") return [...GWS_PRODUCTS];
  const markers: Partial<Record<ProductId, string>> = {
    aad: "aad_successful_commands",
    exo: "exo_successful_commands",
    securitysuite: "securitysuite_successful_commands",
    defender: "defender_successful_commands",
    sharepoint: "SharePoint_successful_commands",
    teams: "teams_successful_commands",
    powerplatform: "powerplatform_successful_commands",
    powerbi: "powerbi_successful_commands",
  };
  return M365_PRODUCTS.filter((product) => {
    const marker = markers[product];
    return marker !== undefined && marker in settings;
  });
}
