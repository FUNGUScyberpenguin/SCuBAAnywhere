import { ADMIN_SDK, GOOGLE_API_CALLS, GoogleApiClient } from "./api.js";
import type { CommandTracker } from "../tracker.js";
import type { GwsProduct } from "../../types.js";

const REPORTS = `${ADMIN_SDK}/admin/reports/v1/activity/users/all/applications/admin`;

/**
 * Some Google Workspace settings are not readable through any API, so
 * ScubaGoggles infers them from admin audit log events instead. That is a real
 * limitation rather than a design choice: an event only exists if an admin
 * changed the setting while the log retention window still covers it.
 *
 * These are the events each baseline reads.
 */
const PRODUCT_EVENTS: Record<GwsProduct, string[]> = {
  assuredcontrols: ["CREATE_APPLICATION_SETTING", "CHANGE_APPLICATION_SETTING", "DELETE_APPLICATION_SETTING"],
  calendar: [],
  chat: ["CHANGE_APPLICATION_SETTING", "CREATE_APPLICATION_SETTING", "DELETE_APPLICATION_SETTING"],
  classroom: [],
  commoncontrols: [
    "CREATE_APPLICATION_SETTING",
    "CHANGE_APPLICATION_SETTING",
    "SYSTEM_DEFINED_RULE_UPDATED",
    "TOGGLE_CAA_ENABLEMENT",
    "TOGGLE_SERVICE_ENABLED",
    "ALLOW_SERVICE_FOR_OAUTH2_ACCESS",
    "DISALLOW_SERVICE_FOR_OAUTH2_ACCESS",
    "UNTRUST_DOMAIN_OWNED_OAUTH2_APPS",
    "TRUST_DOMAIN_OWNED_OAUTH2_APPS",
    "BLOCK_ALL_THIRD_PARTY_API_ACCESS",
    "UNBLOCK_ALL_THIRD_PARTY_API_ACCESS",
    "SIGN_IN_ONLY_THIRD_PARTY_API_ACCESS",
    "DELETE_APPLICATION_SETTING",
  ],
  drive: [
    "CREATE_APPLICATION_SETTING",
    "CHANGE_APPLICATION_SETTING",
    "CHANGE_DOCS_SETTING",
    "DELETE_APPLICATION_SETTING",
  ],
  gemini: ["CHANGE_APPLICATION_SETTING", "CREATE_APPLICATION_SETTING", "DELETE_APPLICATION_SETTING"],
  gmail: [
    "CHANGE_GMAIL_SETTING",
    "CHANGE_APPLICATION_SETTING",
    "CHANGE_EMAIL_SETTING",
    "CREATE_APPLICATION_SETTING",
    "DELETE_APPLICATION_SETTING",
  ],
  groups: [],
  meet: ["CHANGE_APPLICATION_SETTING", "CREATE_APPLICATION_SETTING", "DELETE_APPLICATION_SETTING"],
  sites: [],
};

/**
 * One admin event can belong to several products, so the generic setting events
 * are matched to a product by the APPLICATION_NAME parameter. Without this an
 * event would be counted against every product that asked for it.
 */
const PRODUCT_APPLICATION_NAMES: Partial<Record<GwsProduct, string[]>> = {
  calendar: ["Calendar"],
  chat: ["Google Chat", "Google Workspace Marketplace"],
  assuredcontrols: ["Access Approvals", "Data regions"],
  commoncontrols: [
    "Security",
    "Google Workspace Marketplace",
    "Blogger",
    "Google Books",
    "Google Maps",
    "Google Pay",
    "Google Photos",
    "Google Play",
    "Google Play Console",
    "Timeline - Location History",
    "YouTube",
    "Google Cloud Platform Sharing Options",
    "Multi Party Approval",
    "Data regions",
  ],
  drive: ["Drive and Docs"],
  gmail: ["Gmail"],
  gemini: ["Gemini app", "Gemini in Workspace apps"],
  groups: ["Groups for Business"],
  meet: ["Google Meet", "Google Meet GenAI"],
  sites: ["Sites"],
  classroom: ["Classroom"],
};

/** The events that can land against more than one product. */
const SHARED_EVENTS = new Set([
  "CHANGE_APPLICATION_SETTING",
  "CREATE_APPLICATION_SETTING",
  "DELETE_APPLICATION_SETTING",
]);

interface Activity {
  events?: Array<{ parameters?: Array<{ name?: string; value?: string }> }>;
}

/**
 * Read the admin audit log once per event name and file each entry under the
 * products that asked for it. Returns `<product>_logs` keys, the shape the Rego
 * reads through its `GetEvents` helper.
 */
export async function collectActivityLogs(
  google: GoogleApiClient,
  products: GwsProduct[],
  tracker: CommandTracker,
  onProgress?: (event: string) => void,
): Promise<Record<string, { items: unknown[] }>> {
  const byProduct = new Map<GwsProduct, unknown[]>(products.map((product) => [product, []]));

  // Group products by event so each event is fetched once, not once per product.
  const eventToProducts = new Map<string, GwsProduct[]>();
  for (const product of products) {
    for (const event of PRODUCT_EVENTS[product]) {
      if (!eventToProducts.has(event)) eventToProducts.set(event, []);
      eventToProducts.get(event)!.push(product);
    }
  }

  let anyFailed = false;
  for (const [event, eventProducts] of eventToProducts) {
    onProgress?.(event);
    try {
      const activities = await google.list<Activity>(REPORTS, "items", { eventName: event });

      if (!SHARED_EVENTS.has(event)) {
        for (const product of eventProducts) byProduct.get(product)!.push(...activities);
        continue;
      }
      for (const activity of activities) {
        for (const name of applicationNames(activity)) {
          for (const product of eventProducts) {
            if (PRODUCT_APPLICATION_NAMES[product]?.includes(name)) byProduct.get(product)!.push(activity);
          }
        }
      }
    } catch (error) {
      anyFailed = true;
      tracker.failures.push({
        command: GOOGLE_API_CALLS.listActivities,
        message: `${event}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  if (!anyFailed && eventToProducts.size > 0) tracker.successful.push(GOOGLE_API_CALLS.listActivities);

  const logs: Record<string, { items: unknown[] }> = {};
  for (const [product, items] of byProduct) logs[`${product}_logs`] = { items };
  return logs;
}

function applicationNames(activity: Activity): string[] {
  const names: string[] = [];
  for (const event of activity.events ?? []) {
    for (const parameter of event.parameters ?? []) {
      if (parameter.name === "APPLICATION_NAME" && parameter.value) names.push(parameter.value);
    }
  }
  return names;
}
