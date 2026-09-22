/**
 * Sign-in for Google Workspace.
 *
 * This talks to Google's authorization endpoint directly rather than loading
 * Google Identity Services. GIS would work, but it means a third-party script
 * in the page, and `script-src 'self'` is doing real work here: it is part of
 * what stops collected configuration going anywhere. The flow underneath is the
 * same one GIS's token client uses.
 *
 * What comes back is an access token, valid for about an hour, with no refresh
 * token. It is held in a variable and in nothing else.
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_INFO = "https://oauth2.googleapis.com/tokeninfo";
const REVOKE = "https://oauth2.googleapis.com/revoke";

/** Sent by the popup once Google redirects back to this origin. */
const MESSAGE_TYPE = "scubaanywhere:google-oauth";

interface TokenMessage {
  type: typeof MESSAGE_TYPE;
  state: string;
  accessToken?: string;
  expiresIn?: string;
  error?: string;
}

export interface GoogleToken {
  accessToken: string;
  expiresAt: number;
  scopes: string[];
  email?: string;
}

export class GoogleAuth {
  private token: GoogleToken | null = null;

  constructor(
    private readonly clientId: string,
    private readonly scope: string,
  ) {
    if (!clientId) {
      throw new Error("No Google client id is configured. See docs/oauth-setup.md and public/config.example.json.");
    }
  }

  get signedInAs(): string | null {
    return this.token?.email ?? null;
  }

  /** A valid token, prompting for one if there is none or it has expired. */
  async getToken(): Promise<string> {
    // A minute of headroom, so a long collection does not fail mid-request.
    if (this.token && this.token.expiresAt - 60_000 > Date.now()) return this.token.accessToken;
    const token = await this.requestToken();
    this.token = token;
    return token.accessToken;
  }

  async signIn(): Promise<void> {
    this.token = await this.requestToken();
  }

  /**
   * Drop the token here and revoke it at Google, so it cannot be used again
   * even if it were somehow captured.
   */
  async signOut(): Promise<void> {
    const token = this.token;
    this.token = null;
    if (!token) return;
    try {
      await fetch(`${REVOKE}?token=${encodeURIComponent(token.accessToken)}`, { method: "POST", mode: "no-cors" });
    } catch {
      // The local token is already gone; a failed revoke must not block a wipe.
    }
  }

  private async requestToken(): Promise<GoogleToken> {
    const state = randomState();
    const redirectUri = new URL(".", window.location.href).href;

    const url = new URL(AUTH_ENDPOINT);
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "token");
    url.searchParams.set("scope", this.scope);
    url.searchParams.set("include_granted_scopes", "true");
    url.searchParams.set("state", state);
    url.searchParams.set("prompt", "consent");

    const popup = window.open(url.toString(), "scuba-google-auth", "popup,width=520,height=640");
    if (!popup) throw new Error("The sign-in window was blocked. Allow popups for this site and try again.");

    const message = await waitForToken(popup, state);
    if (message.error) throw new Error(`Google refused the sign-in: ${message.error}`);
    if (!message.accessToken) throw new Error("Google returned no access token.");

    return this.describe(message.accessToken, Number(message.expiresIn ?? 3600));
  }

  /**
   * Confirm the token was issued to this application and covers the scopes the
   * collectors need. An implicit-flow token arrives through the browser, so
   * checking its audience is the documented way to be sure it is ours.
   */
  private async describe(accessToken: string, expiresIn: number): Promise<GoogleToken> {
    const response = await fetch(`${TOKEN_INFO}?access_token=${encodeURIComponent(accessToken)}`);
    if (!response.ok) throw new Error(`Google could not describe the access token (HTTP ${response.status}).`);

    const info = (await response.json()) as { aud?: string; scope?: string; email?: string; expires_in?: string };
    if (info.aud !== this.clientId) {
      throw new Error("The access token was issued to a different application; refusing to use it.");
    }

    const scopes = (info.scope ?? "").split(" ").filter(Boolean);
    const missing = this.scope.split(" ").filter((needed) => !scopes.includes(needed));
    if (missing.length > 0) {
      throw new Error(
        `Consent is missing for ${missing.length} scope(s), so the assessment would be incomplete: ` +
          missing.map(shortScope).join(", "),
      );
    }

    const lifetime = Number(info.expires_in ?? expiresIn);
    const token: GoogleToken = {
      accessToken,
      expiresAt: Date.now() + (Number.isFinite(lifetime) ? lifetime : expiresIn) * 1000,
      scopes,
    };
    if (info.email) token.email = info.email;
    return token;
  }
}

function waitForToken(popup: Window, state: string): Promise<TokenMessage> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      clearInterval(closedTimer);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as TokenMessage | undefined;
      if (data?.type !== MESSAGE_TYPE) return;
      // The state ties this response to the request this page made.
      if (data.state !== state) return;
      cleanup();
      popup.close();
      resolve(data);
    };

    const closedTimer = setInterval(() => {
      if (!popup.closed) return;
      cleanup();
      reject(new Error("The sign-in window was closed before Google answered."));
    }, 500);

    window.addEventListener("message", onMessage);
  });
}

/**
 * Called on load. When this page is the OAuth redirect target, it is running
 * inside the popup: hand the fragment to the opener and close.
 *
 * Returns true when the page was a redirect target, so the app knows not to
 * carry on rendering in a window that is about to close.
 */
export function completeGoogleRedirect(): boolean {
  const fragment = window.location.hash.replace(/^#/, "");
  if (!fragment || !window.opener) return false;

  const params = new URLSearchParams(fragment);
  const state = params.get("state");
  if (!state || (!params.has("access_token") && !params.has("error"))) return false;

  const message: TokenMessage = { type: MESSAGE_TYPE, state };
  const accessToken = params.get("access_token");
  const expiresIn = params.get("expires_in");
  const error = params.get("error");
  if (accessToken) message.accessToken = accessToken;
  if (expiresIn) message.expiresIn = expiresIn;
  if (error) message.error = error;

  // Clear the token out of the address bar before anything else can read it.
  window.location.hash = "";
  window.opener.postMessage(message, window.location.origin);
  window.close();
  return true;
}

function randomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const shortScope = (scope: string) => scope.replace("https://www.googleapis.com/auth/", "");
