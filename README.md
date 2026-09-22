# SCuBAAnywhere

CISA publishes two SCuBA assessment tools: [ScubaGear](https://github.com/cisagov/ScubaGear) for
Microsoft 365, written in PowerShell, and [ScubaGoggles](https://github.com/cisagov/ScubaGoggles) for
Google Workspace, written in Python. Both ask you to install a runtime, install the tool, install the
Open Policy Agent binary, and then run a command that writes your tenant's configuration and the
resulting report to disk.

SCuBAAnywhere runs the same assessment in a browser tab. You sign in with OAuth as yourself, the page
reads your tenant's configuration with your own read-only admin rights, evaluates CISA's Rego
policies in the tab, and shows you the report. When you close the tab or press **Wipe session**, the
configuration and the report are gone. Nothing was written to a server, to browser storage, or to
disk unless you chose to save a file.

It is not a CISA project, and it does not modify their policies. It compiles the published Rego to
WebAssembly and runs it unchanged.

## Does it give the same answers?

Yes, for Microsoft 365, and this is checked rather than asserted. `npm run verify-parity` evaluates
CISA's own sample settings export twice: once with the OPA binary the way ScubaGear does it, once
with the WebAssembly bundle the way the browser does it, and diffs every policy result across all
eight products. They match.

One nuance shows up in that diff. Several baselines build their `ActualValue` from a Rego set, and a
set has no order. The OPA binary lists the members sorted; the WebAssembly runtime lists them in its
own order. Same members, same verdict, different order in the text. The parity check reports these
separately instead of hiding them.

## What works today

**Microsoft 365, live collection.** Entra ID is collected straight from the browser against Microsoft
Graph. Exchange Online, the Security Suite, SharePoint, Teams and Power Platform are collected
through the relay (see below). Power BI is not collected yet.

**Both suites, offline evaluation.** Point the page at a `ProviderSettingsExport.json` from ScubaGear
or the equivalent from ScubaGoggles and it evaluates and renders it. All 8 Microsoft products and all
11 Google Workspace products run. The file is read in the page with `FileReader` and is not uploaded.

**Google Workspace, live collection.** Not yet. See [docs/feasibility.md](docs/feasibility.md) for
what that needs, which is a port of ScubaGoggles' Policy API reduction rather than anything
architectural.

A policy whose data never arrived is reported as **not evaluated**, naming the collector that failed.
It is never reported as a pass. That is the mechanism ScubaGear uses, and it is what makes a partial
collection safe to read.

## Quick start

```bash
npm install
npm run setup     # fetch CISA's sources at the pinned commits, build the policy bundles
npm run test      # unit and integration tests
npm run dev       # http://localhost:5173
```

`npm run setup` clones the two CISA repositories at the commits pinned in `tools/upstream.json`,
downloads a checksum-verified OPA binary, and compiles the Rego to WebAssembly. Nothing it produces
is committed: upstream stays the source of truth.

With no configuration the page still evaluates a settings export you already have. To assess a live
tenant, register an Entra application and write a `web/public/config.json`; see
[docs/oauth-setup.md](docs/oauth-setup.md).

## The relay

Microsoft Graph sends the CORS headers a browser app needs. The Exchange Online, Security and
Compliance, SharePoint, Teams and Power Platform admin APIs do not, so a browser cannot call them
directly. `relay/` is a small stateless forwarder for exactly those hosts: it checks the destination
against an allowlist, passes the request on with your own bearer token, returns the response, and
keeps nothing. It has no database, writes no files, and logs only the method, host, path and status.

Entra ID needs no relay. If you only want the Entra baseline, you do not need to deploy anything
beyond the static page. See [docs/relay.md](docs/relay.md).

## Layout

| Path | What it is |
| --- | --- |
| `packages/core` | Collectors, the WebAssembly policy engine, report assembly. No DOM. |
| `web` | The page: OAuth, the run, the report, the exports. |
| `relay` | Stateless forwarder for the admin APIs that refuse browser origins. |
| `tools` | Vendoring, policy and baseline builds, the parity check. |
| `docs` | Architecture, the ephemerality model, OAuth setup, feasibility. |

## Documentation

- [Architecture](docs/architecture.md) — how a run works, end to end.
- [What survives a session](docs/ephemerality.md) — what the privacy claim covers, and what it does not.
- [OAuth setup](docs/oauth-setup.md) — the Entra application registration and its permissions.
- [Feasibility per product](docs/feasibility.md) — which APIs, which need the relay, what is ported.
- [Relay](docs/relay.md) — deploying and pinning it down.

## Licensing

ScubaGear and ScubaGoggles are released by CISA into the public domain under CC0 1.0. This repository
has no licence file yet; pick one before publishing it.
