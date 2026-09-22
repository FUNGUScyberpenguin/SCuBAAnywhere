import { M365_PRODUCTS, PRODUCT_LABELS, type M365Product } from "@scubaanywhere/core";
import { loadConfig, type AppConfig } from "./config.js";
import { MicrosoftAuth } from "./auth/microsoft.js";
import { Session, blockPersistentStorage, warnBeforeLosingData } from "./session.js";
import { evaluateSettings, runMicrosoft365 } from "./run.js";
import { clear, el } from "./ui/dom.js";
import { renderReport } from "./ui/report-view.js";

const session = new Session();
let auth: MicrosoftAuth | null = null;
let config: AppConfig;

const view = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id} in index.html`);
  return node as T;
};

async function main(): Promise<void> {
  blockPersistentStorage();
  warnBeforeLosingData(session);
  config = await loadConfig();

  renderProductPicker();
  wireSettingsUpload();
  wireSignIn();
  wireWipe();

  session.subscribe(renderStatus);
  session.subscribe(renderLog);
  session.subscribe((state) => {
    const results = view("results");
    if (state.assessment) renderReport(results, state.assessment);
    else clear(results);
  });

  if (!config.microsoft.clientId) {
    note("warn", "No Microsoft client id is configured, so live collection is off. You can still evaluate a settings export below.");
  }
  if (!config.relayUrl) {
    note("info", "No relay is configured. Entra ID can be collected straight from the browser; the other products need one.");
  }
}

function renderProductPicker(): void {
  const container = view("products");
  clear(container);
  for (const product of M365_PRODUCTS) {
    // Defender and the Security Suite share one collector and one set of
    // endpoints; offering both would run the same calls twice.
    if (product === "defender") continue;
    const id = `product-${product}`;
    container.append(
      el(
        "label",
        { class: "product-choice", for: id },
        el("input", {
          type: "checkbox",
          id,
          value: product,
          ...(product === "aad" ? { checked: true } : {}),
        }),
        el("span", {}, PRODUCT_LABELS[product]),
        product === "aad"
          ? el("span", { class: "badge" }, "no relay needed")
          : el("span", { class: "badge badge-relay" }, "needs relay"),
      ),
    );
  }
}

const selectedProducts = (): M365Product[] =>
  [...view("products").querySelectorAll<HTMLInputElement>("input:checked")].map((input) => input.value as M365Product);

function wireSignIn(): void {
  view<HTMLButtonElement>("sign-in").addEventListener("click", async () => {
    try {
      auth ??= await MicrosoftAuth.create(config);
      await auth.signIn();
      session.update({ signedInAs: auth.signedInAs ?? undefined });
      session.log("info", `Signed in as ${auth.signedInAs}`);
    } catch (error) {
      fail("Sign-in failed", error);
    }
  });

  view<HTMLButtonElement>("run").addEventListener("click", async () => {
    const products = selectedProducts();
    if (products.length === 0) return note("warn", "Choose at least one product first.");
    if (!auth?.signedInAs) return note("warn", "Sign in before collecting.");

    const button = view<HTMLButtonElement>("run");
    button.disabled = true;
    try {
      const assessment = await runMicrosoft365({ config, auth, session, products });
      session.update({ assessment });
      session.log("info", `Done: ${assessment.policies.length} policies evaluated`);
    } catch (error) {
      fail("Collection failed", error);
    } finally {
      button.disabled = false;
    }
  });
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
    await auth?.signOut();
    auth = null;
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
