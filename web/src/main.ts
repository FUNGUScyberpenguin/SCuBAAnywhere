import { GWS_PRODUCTS, M365_PRODUCTS, PRODUCT_LABELS, type GwsProduct, type M365Product } from "@scubaanywhere/core";
import { loadConfig, type AppConfig } from "./config.js";
import { MicrosoftAuth } from "./auth/microsoft.js";
import { GoogleAuth, completeGoogleRedirect } from "./auth/google.js";
import { Session, blockPersistentStorage, warnBeforeLosingData } from "./session.js";
import { evaluateSettings, runGoogleWorkspace, runMicrosoft365 } from "./run.js";
import { clear, el } from "./ui/dom.js";
import { renderReport } from "./ui/report-view.js";

const session = new Session();
let microsoft: MicrosoftAuth | null = null;
let google: GoogleAuth | null = null;
let config: AppConfig;

const view = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id} in index.html`);
  return node as T;
};

async function main(): Promise<void> {
  // When this page is the OAuth redirect target it is running inside the popup
  // and has one job: hand the token back and close.
  if (completeGoogleRedirect()) return;

  if (refuseToRunInAFrame()) return;
  blockPersistentStorage();
  warnBeforeLosingData(session);
  config = await loadConfig();

  renderProductPickers();
  wireSettingsUpload();
  wireMicrosoft();
  wireGoogle();
  wireWipe();

  session.subscribe(renderStatus);
  session.subscribe(renderLog);
  session.subscribe((state) => {
    const results = view("results");
    if (state.assessment) renderReport(results, state.assessment);
    else clear(results);
  });

  if (!config.microsoft.clientId) {
    note("warn", "No Microsoft client id is configured, so live Microsoft 365 collection is off.");
  }
  if (!config.google.clientId) {
    note("warn", "No Google client id is configured, so live Google Workspace collection is off.");
  }
  if (!config.relayUrl) {
    note("info", "No relay is configured. Entra ID and all of Google Workspace work without one; the other Microsoft products need it.");
  }
}

function renderProductPickers(): void {
  const microsoftProducts = view("m365-products");
  clear(microsoftProducts);
  for (const product of M365_PRODUCTS) {
    // Defender and the Security Suite share one collector and one set of
    // endpoints; offering both would run the same calls twice.
    if (product === "defender") continue;
    microsoftProducts.append(
      choice(`m365-${product}`, product, PRODUCT_LABELS[product], product === "aad", {
        label: product === "aad" ? "no relay needed" : "needs relay",
        relay: product !== "aad",
      }),
    );
  }

  const googleProducts = view("gws-products");
  clear(googleProducts);
  for (const product of GWS_PRODUCTS) {
    googleProducts.append(choice(`gws-${product}`, product, PRODUCT_LABELS[product], true));
  }
}

function choice(
  id: string,
  value: string,
  label: string,
  checked: boolean,
  badge?: { label: string; relay: boolean },
): HTMLElement {
  return el(
    "label",
    { class: "product-choice", for: id },
    el("input", { type: "checkbox", id, value, ...(checked ? { checked: true } : {}) }),
    el("span", {}, label),
    badge ? el("span", { class: badge.relay ? "badge badge-relay" : "badge" }, badge.label) : null,
  );
}

const selected = <T extends string>(containerId: string): T[] =>
  [...view(containerId).querySelectorAll<HTMLInputElement>("input:checked")].map((input) => input.value as T);

function wireMicrosoft(): void {
  view<HTMLButtonElement>("m365-sign-in").addEventListener("click", async () => {
    try {
      microsoft ??= await MicrosoftAuth.create(config);
      await microsoft.signIn();
      session.update({ signedInAs: microsoft.signedInAs ?? undefined });
      session.log("info", `Signed in to Microsoft 365 as ${microsoft.signedInAs}`);
    } catch (error) {
      fail("Microsoft sign-in failed", error);
    }
  });

  view<HTMLButtonElement>("m365-run").addEventListener("click", async () => {
    const products = selected<M365Product>("m365-products");
    if (products.length === 0) return note("warn", "Choose at least one Microsoft 365 product first.");
    if (!microsoft?.signedInAs) return note("warn", "Sign in to Microsoft 365 before collecting.");

    await withButton("m365-run", async () => {
      const assessment = await runMicrosoft365({ config, auth: microsoft!, session, products });
      session.update({ assessment });
      session.log("info", `Done: ${assessment.policies.length} policies evaluated`);
    }, "Microsoft 365 collection failed");
  });
}

function wireGoogle(): void {
  view<HTMLButtonElement>("gws-sign-in").addEventListener("click", async () => {
    try {
      google ??= new GoogleAuth(config.google.clientId, GOOGLE_SCOPES);
      await google.signIn();
      session.update({ signedInAs: google.signedInAs ?? undefined });
      session.log("info", `Signed in to Google Workspace as ${google.signedInAs}`);
    } catch (error) {
      google = null;
      fail("Google sign-in failed", error);
    }
  });

  view<HTMLButtonElement>("gws-run").addEventListener("click", async () => {
    const products = selected<GwsProduct>("gws-products");
    if (products.length === 0) return note("warn", "Choose at least one Google Workspace product first.");
    if (!google?.signedInAs) return note("warn", "Sign in to Google Workspace before collecting.");

    await withButton("gws-run", async () => {
      const assessment = await runGoogleWorkspace({ config, auth: google!, session, products });
      session.update({ assessment });
      session.log("info", `Done: ${assessment.policies.length} policies evaluated`);
    }, "Google Workspace collection failed");
  });
}

/** The read-only scopes the Google collectors need, as one consent request. */
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/admin.reports.audit.readonly",
  "https://www.googleapis.com/auth/admin.directory.domain.readonly",
  "https://www.googleapis.com/auth/admin.directory.orgunit.readonly",
  "https://www.googleapis.com/auth/admin.directory.user.readonly",
  "https://www.googleapis.com/auth/admin.directory.rolemanagement.readonly",
  "https://www.googleapis.com/auth/admin.directory.group.readonly",
  "https://www.googleapis.com/auth/admin.directory.customer.readonly",
  "https://www.googleapis.com/auth/cloud-identity.policies.readonly",
  "https://www.googleapis.com/auth/cloud-identity.inboundsso.readonly",
].join(" ");

async function withButton(id: string, work: () => Promise<void>, context: string): Promise<void> {
  const button = view<HTMLButtonElement>(id);
  button.disabled = true;
  try {
    await work();
  } catch (error) {
    fail(context, error);
  } finally {
    button.disabled = false;
  }
}

function wireSettingsUpload(): void {
  const input = view<HTMLInputElement>("settings-file");
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      // Read in the page. The file is never sent anywhere.
      const settings = JSON.parse((await file.text()).replace(/^﻿/, "")) as Record<string, unknown>;
      session.log("info", `Read ${file.name} (${Math.round(file.size / 1024)} KiB) in this browser`);
      const assessment = await evaluateSettings(settings, {});
      session.update({ settings, assessment });
      session.log("info", `Evaluated ${assessment.policies.length} policies`);
    } catch (error) {
      fail("Could not evaluate that file", error);
    } finally {
      input.value = "";
    }
  });
}

function wireWipe(): void {
  view<HTMLButtonElement>("wipe").addEventListener("click", async () => {
    if (session.holdsData && !confirm("Discard the collected configuration and the report? This cannot be undone.")) {
      return;
    }
    session.wipe();
    await Promise.all([microsoft?.signOut(), google?.signOut()]);
    microsoft = null;
    google = null;
    // A reload drops every object the page built, including anything a
    // dependency kept a reference to.
    window.location.reload();
  });
}

function renderStatus(state: Session["current"]): void {
  const status = view("status");
  clear(status);
  const holding = state.assessment
    ? `Holding a report for ${state.assessment.target.displayName} in this tab`
    : state.settings
      ? "Holding a settings export in this tab"
      : "Nothing collected";
  status.append(
    el(
      "div",
      {},
      el("span", { class: state.assessment || state.settings ? "status status-holding" : "status" }, holding),
      state.signedInAs ? el("span", { class: "meta" }, ` · Signed in as ${state.signedInAs}`) : null,
    ),
  );
}

function renderLog(state: Session["current"]): void {
  const log = view("log");
  clear(log);
  for (const entry of state.log.slice(-200)) {
    log.append(
      el(
        "div",
        { class: `log-entry log-${entry.level}` },
        el("time", {}, entry.at.slice(11, 19)),
        el("span", {}, entry.message),
      ),
    );
  }
  log.scrollTop = log.scrollHeight;
}

/**
 * A framed copy of this page could be dressed up by whatever embedded it, and
 * the operator would be signing in to Microsoft or Google through someone
 * else's chrome. `frame-ancestors` is the right way to stop that, but a meta
 * Content-Security-Policy cannot express it and a static host cannot set the
 * header, so the page refuses to run instead.
 *
 * Returns true when the page is framed and has been stopped.
 */
function refuseToRunInAFrame(): boolean {
  if (window.self === window.top) return false;

  document.body.replaceChildren(
    el(
      "main",
      { class: "card" },
      el("h2", {}, "SCuBAAnywhere will not run in a frame"),
      el(
        "p",
        {},
        "This page signs you in to your tenant, so it only runs as the top-level page where you can " +
          "see the address bar. Open it directly.",
      ),
    ),
  );
  return true;
}

function note(level: "info" | "warn", message: string): void {
  session.log(level, message);
}

function fail(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  session.log("error", `${context}: ${message}`);
}

void main().catch((error: unknown) => {
  // Failing to start must still say why, in the page rather than the console.
  const log = document.getElementById("log");
  const message = error instanceof Error ? error.message : String(error);
  if (log) log.textContent = `SCuBAAnywhere could not start: ${message}`;
});
