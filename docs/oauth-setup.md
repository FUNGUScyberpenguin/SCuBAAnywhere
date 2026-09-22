# OAuth setup

SCuBAAnywhere signs in as you, not as a service principal. You get the access your own admin roles
already give you, the tenant's sign-in logs record who ran the assessment, and there is no
certificate or client secret to store. It is a public OAuth client using the authorization code flow
with PKCE, which is the right shape for a static page: a secret shipped to a browser is not a secret.

## Register the application

In the Microsoft Entra admin center, under **App registrations**, create a new registration.

- **Name**: anything, for example `SCuBAAnywhere`.
- **Supported account types**: accounts in any organizational directory, if you assess more than one
  tenant. A single tenant registration works too.
- **Redirect URI**: platform **Single-page application**, set to the URL the page is served from,
  including the trailing slash. For local development that is `http://localhost:5173/`.

Do not add a client secret or a certificate. The app has no server to keep one on.

## Permissions

Add these as **delegated** Microsoft Graph permissions. They are the same ones ScubaGear's
prerequisites document lists for interactive use, and every one is read-only:

| Permission | Why |
| --- | --- |
| `Directory.Read.All` | Directory roles, role templates, role members |
| `Policy.Read.All` | Conditional access, authorization policy, authentication methods, app management |
| `RoleManagement.Read.Directory` | Role assignment and eligibility schedules |
| `RoleManagementPolicy.Read.AzureADGroup` | PIM role management policy rules |
| `PrivilegedAccess.Read.AzureADGroup` | PIM for Groups |
| `PrivilegedEligibilitySchedule.Read.AzureADGroup` | PIM for Groups eligibility |
| `User.Read.All` | Privileged user details and the tenant user count |

Grant admin consent for the tenant. Without it, each signed-in admin is prompted individually and
some permissions cannot be consented to at all.

For the products behind the relay, the app also needs delegated permission to those APIs. Add them
under **APIs my organization uses**:

| Product | API | Permission |
| --- | --- | --- |
| Exchange Online, Security Suite | Office 365 Exchange Online | `Exchange.Manage` |
| SharePoint | Office 365 SharePoint Online | `AllSites.FullControl` |
| Teams | Skype and Teams Tenant Admin API | `application_access` |
| Power Platform | PowerApps Service | `user_impersonation` |

The SharePoint entry is not a typo and it is not read-only. SharePoint's tenant settings endpoint has
no read-only delegated permission; ScubaGear's own prerequisites carry the same caveat for its
service principal. SCuBAAnywhere issues only `GET /_api/SPO.Tenant`, but the grant is broader than
the use, so leave SharePoint deselected if that trade is not one you want to make.

## Roles

Your account needs the roles ScubaGear asks for. **Global Reader** covers Entra ID, Exchange Online,
the Security Suite, SharePoint and Teams. Power Platform needs **Power Platform Administrator** with
a Power Apps for Office 365 licence. Power BI is not collected yet.

## Configure the page

Copy `web/public/config.example.json` to `web/public/config.json`:

```json
{
  "microsoft": {
    "clientId": "<application (client) id>",
    "authority": "https://login.microsoftonline.com/organizations",
    "environment": "commercial"
  },
  "relayUrl": "https://scuba-relay.example.gov",
  "dns": { "enabled": false, "resolverUrl": "https://cloudflare-dns.com/dns-query" }
}
```

`authority` can be `organizations` for any work or school tenant, or
`https://login.microsoftonline.com/<tenant-id>` to pin one. `environment` is `commercial`, `gcc`,
`gcchigh` or `dod`, and it selects the endpoints for every product. Leave `relayUrl` empty to assess
Entra ID only.

Turning `dns` on sends your accepted domain names to the resolver you name. Leaving it off means the
SPF, DKIM and DMARC policies report as not evaluated rather than quietly passing.

The file holds no secrets and is served as a static asset.

## Google Workspace

Google needs a project with the APIs enabled and an OAuth client. Unlike ScubaGoggles, there is no
credentials file to download and no service account: the browser gets a one-hour access token and no
refresh token.

### Enable the APIs

In the Google Cloud console, on the project you want to use, enable:

- Admin SDK API
- Cloud Identity API

### Create the OAuth client

Under **APIs & Services → Credentials**, create an **OAuth client ID** of type **Web application**.

- **Authorized JavaScript origins**: the origin the page is served from, for example
  `https://scuba.example.gov`, or `http://localhost:5173` for development.
- **Authorized redirect URIs**: the same URL including the trailing slash, e.g.
  `https://scuba.example.gov/`. The sign-in popup returns here.

There is no client secret to configure. If the console gives you one, you do not need it.

On the **OAuth consent screen**, set the user type to **Internal** so only your own organisation can
consent, and add the scopes below. An external consent screen would need Google verification for
these scopes and would let accounts outside your tenant attempt sign-in.

### Scopes

All read-only, and the same set ScubaGoggles requests
(`scubagoggles/scuba_constants.py`):

| Scope | Why |
| --- | --- |
| `admin.directory.orgunit.readonly` | Org unit names and paths |
| `admin.directory.group.readonly` | Group names, and a user's memberships |
| `admin.directory.user.readonly` | Super admins and delegated admins |
| `admin.directory.rolemanagement.readonly` | Admin roles and who holds them |
| `admin.directory.domain.readonly` | Domains, for the SPF, DKIM and DMARC checks |
| `admin.directory.customer.readonly` | The tenant's canonical customer id |
| `admin.reports.audit.readonly` | Settings only visible as admin log events |
| `cloud-identity.policies.readonly` | Nearly every setting the baselines read |
| `cloud-identity.inboundsso.readonly` | Which SSO profile applies to which users |

ScubaGoggles also asks for `apps.groups.settings` and `apps.licensing`. SCuBAAnywhere does not: no
Rego policy reads either one.

### Roles

Sign in with a Google Workspace **super administrator**, or an admin with the Services, Groups and
User Management privileges. The Policy API returns only what the signed-in admin may read, so a
narrower account produces a thinner assessment rather than an error.

### Configure the page

Add the client id to `web/public/config.json`:

```json
"google": {
  "clientId": "000000000000-xxxxxxxxxxxx.apps.googleusercontent.com",
  "customerId": "my_customer"
}
```

`my_customer` means the signed-in admin's own tenant, which is almost always what you want. A
reseller managing another tenant puts that tenant's customer id here instead.

### A note on the sign-in flow

SCuBAAnywhere calls Google's authorization endpoint directly rather than loading Google Identity
Services. The flow underneath is the same one GIS's token client uses; skipping the library keeps
`script-src 'self'` in the page's Content Security Policy, which is part of what stops collected
configuration going anywhere it should not. The token's audience is checked against your client id
before it is used, and it is revoked at Google when you wipe the session.
