# Architecture

A SCuBA assessment is three steps: read the tenant's configuration, evaluate it against the
baselines, render the result. ScubaGear and ScubaGoggles do all three on a workstation. SCuBAAnywhere
does all three in a browser tab, and the interesting question is what that costs.

## The finding that makes it possible

ScubaGear used to drive PowerShell modules: the Graph SDK, Exchange Online Management, the Power
Platform admin module, PnP. If that were still true, a browser port would mean reimplementing a
PowerShell remoting layer.

It isn't. Reading `PowerShell/ScubaGear/Modules/Providers/` at the pinned commit, every provider now
calls a REST endpoint with a bearer token:

- `Invoke-GraphDirectly` for Entra ID
- `Invoke-EXORestMethod`, which POSTs a cmdlet name to
  `https://outlook.office365.com/adminapi/beta/{tenant}/InvokeCommand`, for Exchange Online and the
  Security Suite
- `Get-SPOTenantRest`, `Get-Teams*Rest`, `Get-PowerPlatform*Rest` for the rest

The endpoints, the token audiences and the required permissions are all in one machine-readable file,
`PowerShell/ScubaGear/schemas/ScubaGearApiCatalog.json`. So the collectors in `packages/core` are a
direct translation, not a reimplementation, and `docs/feasibility.md` tracks each one against its
upstream source.

## The policies run unchanged

CISA writes the baselines in Rego and evaluates them with the OPA binary at the entrypoint
`data.<product>.tests`. OPA can compile Rego to WebAssembly, and `@open-policy-agent/opa-wasm` runs
the result in a browser, so the policies do not have to be rewritten or translated.

`tools/build-policies.mjs` runs `opa build -t wasm` once per suite with one entrypoint per product:
one 620 KiB module covering the eight Microsoft baselines, another covering the eleven Google
Workspace baselines.

Two details had to be handled.

**Missing built-ins.** OPA compiles most built-in functions into the module but leaves a handful to
the host, and the JavaScript SDK does not implement `indexof_n` or `regex.find_n`. Both are used by
CISA's baselines, so evaluation fails outright without them.
`packages/core/src/opa/builtins.ts` supplies them. Go's regexp is RE2 and JavaScript's is
backtracking, so the two are not interchangeable in general; the patterns CISA uses are literals and
character classes, which both read identically.

**Key casing.** Graph returns `displayName`; the Rego reads `DisplayName`, because the PowerShell SDK
capitalises on the way through. `pascalize` in `graph.ts` reproduces
ScubaGear's `ConvertFrom-GraphHashtable` exactly, which is why the same Rego works against data
collected by a browser.

## A run, end to end

1. **Sign in.** MSAL, authorization code flow with PKCE, no client secret, token cache in memory.
2. **Identify the tenant.** `GET /beta/organization`, which also yields the SharePoint host prefix.
3. **Collect.** Each product's collector runs its calls through a `CommandTracker`. A call that
   fails is recorded as unsuccessful and the collection continues.
4. **Merge.** The collectors' output is merged into one settings export, the same document ScubaGear
   writes to `ProviderSettingsExport.json`. Here it stays in memory.
5. **Evaluate.** The WebAssembly module is evaluated once per product against that export.
6. **Report.** Each verdict is joined to the baseline text — requirement, rationale, remediation —
   normalised from CISA's published baselines by `tools/build-baselines.mjs`.

## Why a failed collector is not a failed policy

This is the part worth getting right. If a collector returns nothing and the Rego evaluates against
an empty object, most policies report a pass. A report full of passes that means "we could not look"
is worse than no report.

ScubaGear solves it with the command tracker, and SCuBAAnywhere uses the same mechanism. Each Rego
result names the commands it depends on in its `Commandlet` field. `classify()` in `report.ts`
intersects that list with the collectors that failed, and any policy with a non-empty intersection is
reported as **not evaluated**, naming the missing collector. The verdict names — pass, fail, warning,
manual, error — are ScubaGear's own, so a web report and a PowerShell report can be compared line for
line.

This is also how unimplemented collectors stay honest. Power BI collection is not written yet, so the
Power BI collector marks itself skipped and its policies come back as not evaluated rather than as
passes.

## The relay

Microsoft Graph sends `Access-Control-Allow-Origin` and can be called from a page. The Exchange
Online, Security and Compliance, SharePoint, Teams and Power Platform admin APIs do not, and no
amount of client-side work changes that. Those requests go through `relay/`, which forwards them with
the caller's own token.

A forwarder that accepts an arbitrary destination is an open proxy, so `relay/src/allowlist.ts` pins
it down: https only, no credentials in the URL, the default port, an exact host match (SharePoint's
tenant-specific host is the one pattern), and a path prefix per host. The tests cover the lookalike
cases — `outlook.office365.com.evil.example` and `evil-outlook.office365.com` are both refused.

The relay holds nothing. No storage, no cache, no bodies or tokens in the log.

## What it costs compared to running the tools locally

You give up two things. The relay is infrastructure that ScubaGear does not need, and it sits on the
path of your tenant's configuration even though it keeps none of it. And the collectors here are a
second implementation of ScubaGear's providers, which will drift unless the pin in
`tools/upstream.json` is bumped deliberately and the parity check re-run.

You get back: no PowerShell, no Python, no OPA install, no elevated workstation, nothing written to
disk by default, and a report that a reviewer can open on a machine that is not theirs without
leaving a copy behind.
