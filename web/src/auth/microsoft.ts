import {
  BrowserCacheLocation, InteractionRequiredAuthError, PublicClientApplication,
  type AccountInfo, type Configuration,
} from "@azure/msal-browser";
import type { AppConfig } from "../config.js";

/**
 * Sign-in and token acquisition for Microsoft 365.
 *
 * Authorization code flow with PKCE, no client secret, and a token cache that
 * lives in memory. Closing the tab ends the session: there is no refresh token
 * on disk and nothing in localStorage for the next visitor to find.
 *
 * Scopes are requested per service as the run needs them, so an operator who
 * only assesses Entra ID never consents to an Exchange Online token.
 */
export class MicrosoftAuth {
  private readonly msal: PublicClientApplication;
  private account: AccountInfo | null = null;

  private constructor(msal: PublicClientApplication) {
    this.msal = msal;
  }

  static async create(config: AppConfig): Promise<MicrosoftAuth> {
    if (!config.microsoft.clientId) {
      throw new Error("No Microsoft client id is configured. See docs/oauth-setup.md and public/config.example.json.");
    }
    const options: Configuration = {
      auth: {
        clientId: config.microsoft.clientId,
        authority: config.microsoft.authority,
        redirectUri: new URL(".", window.location.href).href,
      },
      cache: {
        // The whole point: no tokens on disk for the next visitor to find.
        // MSAL v5 no longer writes auth state to cookies either.
        cacheLocation: BrowserCacheLocation.MemoryStorage,
      },
      system: { loggerOptions: { loggerCallback: () => {} } },
    };
    const msal = new PublicClientApplication(options);
    await msal.initialize();

    const auth = new MicrosoftAuth(msal);
    const redirect = await msal.handleRedirectPromise();
    auth.account = redirect?.account ?? msal.getAllAccounts()[0] ?? null;
    return auth;
  }

  get signedInAs(): string | null {
    return this.account?.username ?? null;
  }

  get tenantId(): string | null {
    return this.account?.tenantId ?? null;
  }

  /**
   * Sign in with the smallest scope that identifies the tenant. Product scopes
   * are requested later, only for the products actually selected.
   */
  async signIn(): Promise<void> {
    const result = await this.msal.loginPopup({ scopes: ["https://graph.microsoft.com/.default"], prompt: "select_account" });
    this.account = result.account;
  }

  /** Acquire a token for one service, prompting only if consent is missing. */
  async getToken(scope: string): Promise<string> {
    if (!this.account) throw new Error("Sign in before collecting.");
    const request = { scopes: [scope], account: this.account };
    try {
      return (await this.msal.acquireTokenSilent(request)).accessToken;
    } catch (error) {
      if (!(error instanceof InteractionRequiredAuthError)) throw error;
      return (await this.msal.acquireTokenPopup(request)).accessToken;
    }
  }

  /**
   * End the session in this tab and at the identity provider.
   *
   * Clearing the in-memory cache is enough to make this tab forget, but it
   * leaves the sign-in session at login.microsoftonline.com intact, so the next
   * click would sign straight back in. The popup logout ends that too.
   */
  async signOut(): Promise<void> {
    const account = this.account;
    this.account = null;
    if (!account) return;
    try {
      await this.msal.logoutPopup({ account });
    } catch {
      // A blocked popup must not stop the local wipe; that already happened.
    }
  }
}
