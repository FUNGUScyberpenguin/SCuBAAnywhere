# The relay

The relay exists for one reason: Microsoft's admin APIs for Exchange Online, the Security Suite,
SharePoint, Teams and Power Platform do not send CORS headers, so a browser cannot call them. Graph
does, so **Entra ID needs no relay**. If the Entra baseline is all you want, skip this page.

## What it does and does not do

It checks the destination against an allowlist, forwards the request with your own bearer token, and
returns the response. That is all.

It has no database and writes no files. It keeps no cache. It logs the method, the upstream host, the
path and the status — never a query string, a header, a token or a body. Your configuration passes
through the process and is gone when the response ends.

Run it inside your own boundary. It sees your tenant's configuration and your access tokens in
flight, so a relay someone else operates is a relay someone else could log.

## Running it

```bash
npm run build -w @scubaanywhere/relay
SCUBA_RELAY_ORIGIN=https://scuba.example.gov npm run relay
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `SCUBA_RELAY_ORIGIN` | none, required | The one browser origin allowed to call it. There is no wildcard, and it refuses to start without this. |
| `PORT` | `8787` | Listen port. |
| `SCUBA_RELAY_MAX_BODY` | `1000000` | Largest request body accepted, in bytes. |
| `SCUBA_RELAY_TIMEOUT_MS` | `120000` | Upstream timeout. |

Then set `relayUrl` in `web/public/config.json` and add the relay's origin to the page's
`connect-src`.

`GET /healthz` answers `{"status":"ok"}` for a load balancer.

## The allowlist

A forwarder that accepts any destination is an open proxy. `relay/src/allowlist.ts` refuses anything
that is not:

- `https`, on the default port, with no credentials in the URL
- an exact host match from the fixed list, or a tenant SharePoint admin host matching
  `<tenant>-admin.sharepoint.com` (`.us` and `-mil.us` for the government clouds)
- a path under a prefix that a collector actually uses: `/adminapi/` for Exchange Online and
  compliance, `/Skype.Policy/` and `/AdminAppCatalog/` for Teams, `/providers/` for Power Platform,
  `/_api/` for SharePoint

The tests cover the cases that matter: `outlook.office365.com.evil.example` and
`evil-outlook.office365.com` are both refused, and `https://contoso-admin.sharepoint.com/sites/HR/Documents`
is refused because a document library is not the tenant settings endpoint.

Only these request headers are forwarded: `authorization`, `content-type`, `accept`, `prefer`,
`x-responseformat`, `consistencylevel`. Cookies are not among them, in either direction.

## Deployment notes

Put it behind TLS. Do not put an access log with query strings in front of it: the target URL is a
query parameter and it names tenant hosts. Nothing else needs to reach it, and it needs to reach only
the hosts on the allowlist, so an egress rule for those hosts is worth writing.

It is a single Node process with no dependencies beyond the standard library, so it runs as well in a
container as it does on a small VM.
