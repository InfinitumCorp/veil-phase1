/* VEIL Sign In: the browser side of the "Sign In" link on the start page.
 *
 * VEIL stays anonymous at the network level whether or not the user signs
 * in: every connection, including sign-in, goes over Tor, so no site learns
 * the user's IP address or location. Signing in tells only the Infinitum
 * service (Cumulus://ID) who the user is, and New Identity clears that
 * session like any other.
 *
 * Security rules this module enforces:
 *  - The sign-in address comes from the signed app registry bundled with
 *    the browser, never from the start page. A compromised or spoofed page
 *    therefore cannot send the user to a look-alike sign-in site.
 *  - Only https:// addresses are opened, in a normal new tab, so the user
 *    sees the real address bar and the site's certificate.
 *  - Nothing here reads, stores or fills passwords.
 *
 * Sign In goes to Cumulus://ID:
 *  - When the registry carries Cumulus://ID's sign-in addresses
 *    (registry.signin.cid), Sign In runs the full Cumulus://ID sign-in
 *    (VeilCumulusID.sys.mjs) and the start page shows the user signed in.
 *  - Until then, Sign In opens the Cumulus://ID page (registry.signin.url).
 *
 * Wired up by patch 0002 ([chrome]) in the about:veil-home parent actor:
 *   case "VEIL:OpenSignIn": await VeilSignIn.open({ registry, openTab, cumulusId }); break;
 *   case "VEIL:GetAccount": reply("VEIL:Account", VeilSignIn.account()); break;
 * and in a navigation listener on every tab:
 *   if (cumulusId.isRedirect(url)) { cancel(); closeTab();
 *     await VeilSignIn.finish({ cumulusId, address: url }); }
 */

export class SignInError extends Error {}

/** Return the sign-in URL from a verified registry, or throw. */
export function signInUrl(registry) {
  const entry = registry && registry.signin;
  if (!entry || typeof entry.url !== "string") {
    throw new SignInError("this build has no sign-in address");
  }
  let url;
  try {
    url = new URL(entry.url);
  } catch {
    throw new SignInError("sign-in address is not a valid URL");
  }
  if (url.protocol !== "https:") throw new SignInError("sign-in address must use https");
  if (url.username || url.password) throw new SignInError("sign-in address must not carry credentials");
  return url.href;
}

/** Account state shown on the start page. */
const state = { signedIn: false, name: "" };
const listeners = new Set();

export const VeilSignIn = {
  /**
   * Sign In: start Cumulus://ID sign-in when it is configured, otherwise
   * open the Cumulus://ID page in a new foreground tab.
   */
  async open({ registry, openTab, cumulusId = null }) {
    if (cumulusId && cumulusId.enabled) return cumulusId.start();
    const href = signInUrl(registry);
    openTab(href, { inBackground: false, relatedToCurrent: true });
    return href;
  },

  /** The Cumulus://ID redirect arrived: finish sign-in and update the page. */
  async finish({ cumulusId, address }) {
    try {
      const account = await cumulusId.handleRedirect(address);
      this.setAccount(account);
      return account;
    } catch (err) {
      this.setAccount({ signedIn: false });
      throw err;
    }
  },

  /** Current account state, as sent to the start page. */
  account() {
    return { signedIn: state.signedIn, name: state.signedIn ? state.name : "" };
  },

  /** Called when Cumulus://ID sign-in finishes or the user signs out. */
  setAccount({ signedIn, name = "" }) {
    state.signedIn = signedIn === true;
    state.name = state.signedIn && typeof name === "string" ? name.slice(0, 64) : "";
    for (const fn of listeners) fn(this.account());
  },

  /** New Identity forgets the account along with every other session. */
  onNewIdentity(cumulusId = null) {
    if (cumulusId) cumulusId.forget();
    this.setAccount({ signedIn: false });
  },

  /** Start pages subscribe to update "Sign In" / "Signed in" live. */
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
