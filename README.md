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

This is checked rather than asserted, and both halves are checked differently because upstream gives
you different things to check against.

**Microsoft 365.** `npm run verify-parity` evaluates CISA's own sample settings export twice: once
with the OPA binary the way ScubaGear does it, once with the WebAssembly bundle the way the browser
does it, and diffs every policy result across all eight products. They match.

One nuance shows up in that diff. Several baselines build their `ActualValue` from a Rego set, and a
set has no order. The OPA binary lists the members sorted; the WebAssembly runtime lists them in its
own order. Same members, same verdict, different order in the text. The parity check reports these
separately instead of hiding them.

**Google Workspace.** Almost everything a Google baseline reads comes from one map that ScubaGoggles
builds by reducing Google's raw Policy API output, and getting that reduction wrong produces a
confident wrong verdict rather than an error. ScubaGoggles pins the reduction down with its own unit
fixtures, so this port runs against those same fixtures: ten files covering the merge, max-map and
list reducers, applied defaults, sub-org-unit and group naming, and the Gmail, DLP and system-rule
parsers. All ten reproduce byte for byte.

The tables that drive the reduction are not transcribed either. `tools/build-gws-tables.mjs` reads
them out of ScubaGoggles' Python source at the pinned commit.

## What works today

**Microsoft 365, live collection.** Entra ID is collected straight from the browser against Microsoft
Graph. Exchange Online, the Security Suite, SharePoint, Teams and Power Platform are collected
through the relay (see below). Power BI is not collected yet.

**Google Workspace, live collection.** All eleven baselines, straight from the browser. Google's
Admin SDK and Cloud Identity APIs accept browser origins, so there is no relay on the path at all and
the configuration never reaches another machine.

**Both suites, offline evaluation.** Point the page at a `ProviderSettingsExport.json` from ScubaGear
or the equivalent from ScubaGoggles and it evaluates and renders it. The file is read in the page
with `FileReader` and is not uploaded.

A policy whose data never arrived is reported as **not evaluated**, naming the collector that failed.
It is never reported as a pass. That is the mechanism both CISA tools use, and it is what makes a
partial collection safe to read.

## Quick start

```bash
npm install
npm run setup     # fetch CISA's sources at the pinned commits, build the policy bundles
npm run test      # unit and integration tests
npm run dev       # http://localhost:5173
```

`npm run setup` clones the two CISA repositories at the commits pinned in `tools/upstream.json`,
downloads a checksum-verified OPA binary, compiles the Rego to WebAssembly, normalises the baseline
text, and extracts the Google policy tables from ScubaGoggles' source. Nothing it produces is
committed: upstream stays the source of truth.

With no configuration the page still evaluates a settings export you already have. To assess a live
tenant, register an Entra application and write a `web/public/config.json`; see
[docs/oauth-setup.md](docs/oauth-setup.md).

## The relay

Microsoft Graph sends the CORS headers a browser app needs. The Exchange Online, Security and
Compliance, SharePoint, Teams and Power Platform admin APIs do not, so a browser cannot call them
directly. `relay/` is a small stateless forwarder for exactly those hosts: it checks the destination
against an allowlist, passes the request on with your own bearer token, returns the response, and
keeps nothing. It has no database, writes no files, and logs only the method, host, path and status.

Entra ID needs no relay, and neither does any part of Google Workspace. If those are all you want,
you do not need to deploy anything beyond the static page. See [docs/relay.md](docs/relay.md).

## Layout

| Path | What it is |
| --- | --- |
| `packages/core` | Collectors, the WebAssembly policy engine, report assembly. No DOM. |
| `web` | The page: OAuth, the run, the report, the exports. |
| `relay` | Stateless forwarder for the admin APIs that refuse browser origins. |
| `tools` | Vendoring, policy, baseline and Google table builds, the parity check. |
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
