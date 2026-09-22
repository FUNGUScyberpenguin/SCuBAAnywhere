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

Better placed than Microsoft, and it needs no relay.

`admin.googleapis.com` and `cloudidentity.googleapis.com` both send CORS headers, so the browser
calls them directly. Every scope is read-only:

| API | What it answers |
| --- | --- |
| `cloudidentity.googleapis.com/v1/policies` | Nearly every setting the baselines read |
| `directory/v1/customer/{id}/orgunits` | Org unit names and paths, and the tenant name |
| `directory/v1/groups` | Group names, and a user's group membership |
| `directory/v1/users` | Super admins, delegated admins |
| `directory/v1/customer/{id}/roles`, `roleassignments` | Who holds a highly privileged role |
| `directory/v1/customer/{id}/domains`, `domainaliases` | Domains, for the DNS checks |
| `cloudidentity.googleapis.com/v1/inboundSsoAssignments` | Which SSO profile applies to whom |
| `reports/v1/activity/.../admin` | Settings only visible as admin log events |

### The part that took the work

Counting `input.<key>` across ScubaGoggles' Rego, 135 of the roughly 170 references are to
`input.policies`: a single map of org unit to settings, built by `scubagoggles/policy_api.py` from
the raw Policy API output. That file is about 1,200 lines, and the reshaping is not incidental.
Policies are sorted by Google's sort order; duplicates for one org unit are reduced by one of three
reducers (max-map, merge, list); Google's documented defaults are filled in for settings it omits;
a service with no SKU is read as disabled; and the Gmail, DLP and system-rule sections go through
custom parsers.

None of it fails safely if it is slightly wrong. The Rego reads `input.policies` directly, so a
mis-reduced setting produces a confident wrong verdict rather than a "not evaluated".

So this port is checked two ways:

- The tables that drive the reduction are extracted from ScubaGoggles' Python source at the pinned
  commit by `tools/build-gws-tables.mjs`, not transcribed. 96 policy sections, 26 defaults, 30
  system-defined alert rules.
- The reduction itself runs against ScubaGoggles' own unit fixtures
  (`scubagoggles/Testing/Unit/Python/data/policyapi_get_policies*.json`). Ten files, covering all
  three reducers, applied defaults, sub-org-unit and group naming, DLP rules that do and do not meet
  the baseline, Gmail address-list flattening, domain detection in allow lists, and system-rule
  completion. All ten reproduce exactly.

### Limits worth knowing

**Some settings are only visible as log events.** Google exposes no API for them, so ScubaGoggles
reads the admin audit log instead, and this does the same. A setting only produces an event if an
admin changed it while the retention window still covers it. Where there is no event, the Rego says
so and recommends a manual check rather than guessing.

**DKIM selectors are guessed.** There is no API for the selectors in use, so `google`, `selector1`
and `selector2` are tried in that order, the same three ScubaGoggles tries. A tenant using a
different selector will look as though it has no DKIM record.

**License data is not collected.** ScubaGoggles reads per-user license assignments to put a summary
on its report's front page. No Rego policy reads it, and enumerating every license assignment is a
lot of user data to pull for a cosmetic field, so it is left out.

**Group settings are not collected.** ScubaGoggles fetches them; nothing in the Rego reads them.

## Keeping this honest

`tools/upstream.json` pins both CISA repositories by commit, not by tag, because a tag can move and
these files decide what every assessment reports. Bumping a pin is a deliberate act that should be
followed by `npm run verify-parity` and by re-reading the diff in `Modules/Providers/`, since a
changed endpoint upstream is a silently wrong collector here.
