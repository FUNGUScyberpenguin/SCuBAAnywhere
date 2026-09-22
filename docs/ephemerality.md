# What survives a session

The claim is narrow and worth stating precisely: **SCuBAAnywhere does not retain your tenant's
configuration or your assessment results after the session.** What follows is how that is enforced,
and where the claim stops.

## What is enforced

**Nothing is stored server-side.** The web app is static files. There is no database, no session
store, no upload endpoint. The relay forwards a request and returns the response; it writes no files
and keeps no cache. If you assess only Entra ID, there is no server involved at all beyond the static
host.

**Nothing is written to browser storage.** The token cache is MSAL's `memoryStorage`, so no token
reaches `localStorage` and none survives a reload. MSAL v5 no longer writes auth state to cookies.
The app writes nothing to storage itself, and `blockPersistentStorage()` replaces
`Storage.prototype.setItem` with a function that throws, so a dependency that tried to cache
something would fail loudly rather than quietly. An end-to-end test asserts that both storage areas
are empty after a full assessment and that a write attempt is refused.

**Evaluation is local.** The Rego runs in the tab, as WebAssembly. Your configuration is not sent
somewhere to be assessed.

**No third-party script runs in the page.** `script-src 'self'` holds, which is why Google sign-in
talks to the authorization endpoint directly instead of loading Google Identity Services.

**Files are written only when you ask.** HTML, JSON and CSV exports are built in the page and handed
to the browser as a download you started. Where that file goes afterwards is your decision, which is
the intended division of responsibility.

**Wiping means wiping.** **Wipe session** drops the in-memory state, signs out at Microsoft and
revokes the Google access token so neither can be used again, and reloads the page, which discards
every object the page built.

**A tenant's data cannot be sent elsewhere.** The page ships a Content Security Policy whose
`connect-src` lists the Microsoft endpoints, the login host and your relay, and nothing else. Injected
script cannot exfiltrate what it cannot connect to. One end-to-end test evaluates a full settings
export and asserts that no request left the page at all.

## Where the claim stops

**The tenant knows.** Every read is an authenticated API call. Entra sign-in logs, unified audit logs
and the admin APIs' own telemetry record that you signed in and what you read. That is as it should
be; it is not something this tool hides, and you should not expect it to.

**DNS checks disclose domain names.** The Exchange Online baseline checks SPF, DKIM and DMARC, which
means TXT lookups. A browser cannot do DNS, so these go to a DNS-over-HTTPS resolver, which learns
which domains you asked about. It is off by default, the resolver is yours to configure, and turning
it off leaves those policies reported as not evaluated rather than silently passed.

**The relay sees the data in flight.** It holds nothing, but your configuration and your bearer
tokens pass through that process. Run it yourself, in your own boundary. Do not use someone else's.
A Google Workspace assessment does not use it at all, and neither does an Entra-only one.

**The exported file is yours to look after.** A saved HTML report contains the same findings a
ScubaGear report does. The tool's retention guarantee ends the moment you click save.

**Memory is not wiped cryptographically.** State is dropped and the page reloaded, which returns it
to the browser's allocator. Nothing overwrites it first, and a browser process under a debugger or in
a crash dump could still contain it. This is the same property every browser-based tool has.

**A hostile page host defeats all of it.** The app is static files served to you. Whoever controls
that origin controls the code in the tab. Serve it yourself, or from a host you would trust with the
data anyway. The Content Security Policy constrains injected script; it does not constrain the
publisher.

## Deploying so the claim holds

- Serve over HTTPS with `Cache-Control: no-store` so intermediaries keep no copy of the page.
- Send the Content Security Policy as a response header, not only the `<meta>` tag, so it can include
  `frame-ancestors 'none'`. Add your relay's origin to `connect-src`.
- Run the relay in your own boundary with `SCUBA_RELAY_ORIGIN` set to your page's origin. There is no
  wildcard, and the relay refuses to start without it.
- Do not put an access log with query strings in front of the relay. The target URL is a query
  parameter, and it names tenant hosts.
- Register the Entra app with read-only delegated permissions. See `docs/oauth-setup.md`.
