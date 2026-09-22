# Deploying to GitHub Pages

GitHub Pages suits this app well. It is static files, all the work happens in
the visitor's browser, and there is no server to hold anything. Push to `main`
and `.github/workflows/pages.yml` builds and publishes.

What Pages cannot do is host the relay, and it cannot set response headers.
Both have consequences worth understanding before you point anyone at the URL.

## Turn it on

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
2. Push to `main`, or run the **Deploy to GitHub Pages** workflow by hand.

The site lands at `https://<user>.github.io/<repo>/`. The workflow works out
that path itself and builds with it, because Vite has to know the prefix at
build time. A repository named `<user>.github.io` is served from the root and
the workflow handles that too.

## Configure it

The app reads `config.json` at startup. The workflow writes that file from
**repository variables**, so changing a client id is an edit in Settings rather
than a commit.

Settings → Secrets and variables → Actions → **Variables**:

| Variable | Default | What it does |
| --- | --- | --- |
| `SCUBA_MS_CLIENT_ID` | empty | Entra application (client) id. Empty turns Microsoft collection off. |
| `SCUBA_MS_AUTHORITY` | `.../organizations` | `organizations` for any work or school tenant, or a specific tenant id to pin one. |
| `SCUBA_M365_ENVIRONMENT` | `commercial` | `commercial`, `gcc`, `gcchigh` or `dod`. |
| `SCUBA_GOOGLE_CLIENT_ID` | empty | Google OAuth client id. Empty turns Google collection off. |
| `SCUBA_GOOGLE_CUSTOMER_ID` | `my_customer` | The signed-in admin's own tenant. |
| `SCUBA_RELAY_URL` | empty | Relay base URL, if you deploy one. |
| `SCUBA_DNS_ENABLED` | `false` | Turns on the SPF, DKIM and DMARC lookups. |
| `SCUBA_DNS_RESOLVER` | Cloudflare | The DNS-over-HTTPS resolver those lookups go to. |

These are variables, not secrets, and that is deliberate. Both OAuth clients are
public clients holding no secret, because a secret shipped to a browser is not a
secret. Putting them in secrets would hide them from you without hiding them
from anyone else.

With none of them set the site still deploys. The settings-export reader works
with no OAuth client at all, so a deployment with nothing configured is a
perfectly good report viewer.

**The relay origin is baked in at build time.** The page's
Content-Security-Policy lives in a meta tag, because a static host cannot send
headers, and a meta policy is read once when the document parses. Setting
`SCUBA_RELAY_URL` adds that origin to `connect-src` during the build; changing
the variable needs a redeploy to take effect. That is the cost of a policy that
cannot be widened at runtime, which is the property worth having.

## Register the redirect URIs

Sign-in fails until the deployed URL is registered with both providers. For a
site at `https://funguscyberpenguin.github.io/SCuBAAnywhere/`:

**Entra** (Authentication → Add a platform → **Single-page application**):

```
https://funguscyberpenguin.github.io/SCuBAAnywhere/
```

Include the trailing slash, and pick the single-page application platform rather
than Web. Choosing Web produces `AADSTS9002326: Cross-origin token redemption is
permitted only for the 'Single-Page Application' client-type` at sign-in.

**Google** (the OAuth client):

- Authorised JavaScript origins: `https://funguscyberpenguin.github.io`
- Authorised redirect URIs: `https://funguscyberpenguin.github.io/SCuBAAnywhere/`

Note the redirect URI. The `/google-scan` page on mason-sc-site leaves that list
empty, correctly, because Google Identity Services hands the token back through
a JavaScript callback. SCuBAAnywhere does not load that script, so the token
comes back through a redirect and the URI has to be registered. See
[OAuth setup](oauth-setup.md).

## What you give up on Pages

**No relay, so five Microsoft products cannot be collected live.** Entra ID and
all eleven Google Workspace baselines work, because Graph and Google's APIs
accept browser origins. Exchange Online, the Security Suite, SharePoint, Teams
and Power Platform need the relay, which is a Node process and has to live
somewhere else. Point `SCUBA_RELAY_URL` at it once you have one. Until then
those products report as not evaluated rather than silently passing.

**No response headers.** Three things follow:

- `frame-ancestors` cannot be expressed in a meta policy, and `X-Frame-Options`
  cannot be sent, so the app checks `window.self === window.top` on startup and
  refuses to run framed. That is weaker than a header, because it runs after the
  document is parsed rather than before it loads.
- `Cache-Control: no-store` cannot be set. This matters less than it looks: the
  page is static and holds no tenant data. Nothing worth caching leaks, because
  nothing worth caching is ever served.
- The CSP is a meta tag, which is enforced but cannot be updated without a
  redeploy.

**The origin is shared.** `https://<user>.github.io` is one origin for every
project page that user publishes. Browser storage and the OAuth origin are
shared across all of them. SCuBAAnywhere keeps tokens in memory and refuses
Web Storage writes, but a different app of yours on the same origin is under no
such restraint, and your Google client's authorised origin covers all of them.
If that matters for the tenants you assess, use a custom domain (Settings →
Pages → Custom domain) so the app has an origin of its own.

## Deploying somewhere that can set headers

If you host this anywhere with header control, send the same policy as a
response header with `frame-ancestors 'none'` added, plus
`Cache-Control: no-store`. The meta tag then becomes belt and braces rather than
the only line of defence. `docs/ephemerality.md` has the full list.
