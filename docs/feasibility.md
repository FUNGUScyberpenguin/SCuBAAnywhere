# Feasibility per product

Two questions decide whether a product can be assessed from a browser: does its API answer a bearer
token over REST, and does it send the CORS headers a page needs. The first is yes everywhere, because
ScubaGear itself moved off the PowerShell modules. The second is yes only for Microsoft Graph and the
Google APIs.

## Microsoft 365

| Product | Endpoint | Token audience | Browser-direct | Collected here |
| --- | --- | --- | --- | --- |
| Entra ID | `graph.microsoft.com` | `https://graph.microsoft.com/.default` | Yes | Yes |
| Exchange Online | `outlook.office365.com/adminapi/beta/{tenant}/InvokeCommand` | `https://outlook.office365.com/.default` | No | Yes, via relay |
| Security Suite | same, plus `ps.compliance.protection.outlook.com` | as above, plus the compliance host | No | Yes, via relay |
| SharePoint | `{tenant}-admin.sharepoint.com/_api/SPO.Tenant` | `https://{tenant}-admin.sharepoint.com/.default` | No | Yes, via relay |
| Teams | `api.interfaces.records.teams.microsoft.com` | `48ac35b8-…/.default` | No | Yes, via relay |
| Power Platform | `api.bap.microsoft.com` | `https://service.powerapps.com//.default` | No | Yes, via relay |
| Power BI | admin API | separate audience | No | No |

Endpoints and audiences come from `PowerShell/ScubaGear/schemas/ScubaGearApiCatalog.json`, which also
carries the GCC, GCC High and DoD variants; `packages/core/src/collectors/m365/endpoints.ts` is a
transcription of it.

### What is not ported yet

**Power BI.** The admin API needs a tenant setting enabled per security group before it answers, and
it uses its own token audience. Both are straightforward; neither is written.

**Risky application permissions (Entra).** `AADRiskyPermissionsHelper.psm1` is roughly 700 lines that
walk service principals, applications and federated credentials and score them. Only one policy in
the `aad` baseline reads its output, `risky_delegated_permission_classifications`, so the collector
marks itself skipped and that policy reports as not evaluated. The rest of the Entra baseline is
unaffected.

**Teams unified app settings.** `substrate.office.com` with a third token audience, for one input key.

**PIM for Groups rule enrichment.** `GetConfigurationsForPimGroups` adds group-scoped PIM rules to
the privileged role array. Directory-role PIM rules are collected; the group-scoped ones are not.

### DNS

The Exchange Online baseline checks SPF, DKIM and DMARC, which means TXT lookups, which a browser
cannot do. `collectors/dns.ts` uses DNS-over-HTTPS against a resolver you configure. It is off by
default because it tells that resolver which domains you asked about. Off means those policies report
as not evaluated.

## Google Workspace

Better placed than Microsoft, and further from finished.

The APIs are friendlier. `admin.googleapis.com` and `cloudidentity.googleapis.com` both send CORS
headers, so a browser can call them directly with a Google Identity Services token and no relay is
needed at all. The scopes ScubaGoggles requests are in `scubagoggles/scuba_constants.py`, and all
eleven are read-only:

```
admin.directory.customer.readonly      admin.directory.domain.readonly
admin.directory.group.readonly         admin.directory.orgunit.readonly
admin.directory.rolemanagement.readonly admin.directory.user.readonly
admin.reports.audit.readonly           cloud-identity.inboundsso.readonly
cloud-identity.policies.readonly       apps.groups.settings
apps.licensing
```

The work is in the middle. Counting `input.<key>` across ScubaGoggles' Rego, 135 of the roughly 170
references are to `input.policies` — a single map of org unit to settings, built by
`scubagoggles/policy_api.py` from the Cloud Identity Policies API. That file is about 1,200 lines,
and the reshaping is not incidental: policies are sorted by Google's sort order, reduced per org unit
and group by one of three reducers (max, merge, list), defaults are applied for settings Google omits,
and DLP, Gmail and system rules go through custom parsers.

A partial port would not fail safely. The Rego reads `input.policies` directly, so a missing or
mis-reduced setting produces a confident wrong verdict rather than a "not evaluated". That is why
there is no half-finished Google collector in this repository: evaluating an export ScubaGoggles
produced is correct today, and a live collector lands when the reduction is ported and tested against
ScubaGoggles' own fixtures.

All eleven Google Workspace baselines already run in the browser engine. Only the collection is
missing.

## Keeping this honest

`tools/upstream.json` pins both CISA repositories by commit, not by tag, because a tag can move and
these files decide what every assessment reports. Bumping a pin is a deliberate act that should be
followed by `npm run verify-parity` and by re-reading the diff in `Modules/Providers/`, since a
changed endpoint upstream is a silently wrong collector here.
