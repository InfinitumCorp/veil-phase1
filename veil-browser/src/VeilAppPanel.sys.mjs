/* VEIL app panel: Infinitum apps run in a side panel, like ChatGPT's sidebar.
 *
 * Clicking /CNDCTR/ or SCALVS.ai on the start page opens that app in a panel
 * docked to the right of the window, next to whatever page the user is on,
 * instead of navigating away. Clicking the same app again closes the panel;
 * clicking the other app switches the panel to it.
 *
 * Security rules this module enforces:
 *  - The start page sends only an app id. The address comes from the signed
 *    app registry bundled with the browser, never from the page, so a
 *    spoofed page cannot load a look-alike app into the panel.
 *  - Only https:// addresses with no embedded credentials are loaded.
 *  - The panel is an ordinary web content browser: it goes over Tor like
 *    every other connection, and New Identity closes it and clears its
 *    session with everything else.
 *
 * Browser glue (patch 0002, [chrome]) supplies a `panel` object backed by a
 * remote <browser> element in the sidebar box:
 *   panel.show({ url, title })  load url and show the panel
 *   panel.hide()                hide the panel and unload its page
 *   panel.setWidth(px)          resize the panel
 * and calls VeilAppPanel.handle(message) for "VEIL:OpenAppPanel".
 */

export class AppPanelError extends Error {}

export const DEFAULT_WIDTH = 420;
export const MIN_WIDTH = 320;
export const MAX_WIDTH = 720;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Look up an app in a verified registry and return its safe address.
 * allowLoopbackHttp lets the local prototype use http://localhost; the real
 * browser never sets it.
 */
export function appEntry(registry, id, { allowLoopbackHttp = false } = {}) {
  const apps = registry && Array.isArray(registry.apps) ? registry.apps : [];
  const app = apps.find(a => a && a.id === id);
  if (!app) throw new AppPanelError(`no app with id '${id}' in this build`);
  if (app.panel !== true) throw new AppPanelError(`app '${id}' doesn't open in the side panel`);
  let url;
  try {
    url = new URL(app.url);
  } catch {
    throw new AppPanelError(`app '${id}' has an invalid address`);
  }
  const loopbackOk = allowLoopbackHttp && url.protocol === "http:" && LOOPBACK.has(url.hostname);
  if (url.protocol !== "https:" && !loopbackOk) throw new AppPanelError(`app '${id}' must use https`);
  if (url.username || url.password) throw new AppPanelError(`app '${id}' address must not carry credentials`);
  return { id: app.id, title: app.name, url: url.href };
}

export const clampWidth = px =>
  Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(Number.isFinite(px) ? px : DEFAULT_WIDTH)));

export class AppPanel {
  constructor({ registry, panel, allowLoopbackHttp = false }) {
    this.registry = registry;
    this.loopback = { allowLoopbackHttp };
    this.panel = panel;
    this.openId = null;
    this.width = DEFAULT_WIDTH;
  }

  /** Open an app, switch to it, or close it if it is already open. */
  toggle(id) {
    if (this.openId === id) {
      this.close();
      return null;
    }
    const entry = appEntry(this.registry, id, this.loopback);
    if (this.openId === null) this.panel.setWidth(this.width);
    this.panel.show({ url: entry.url, title: entry.title });
    this.openId = id;
    return entry;
  }

  /**
   * Open an app with a prompt typed in the address bar (VeilAppCommands).
   * Always opens (never toggles closed); the prompt rides in the URL
   * fragment, which is never sent to a server.
   */
  openWithPrompt(id, prompt) {
    const entry = appEntry(this.registry, id, this.loopback);
    const url = new URL(entry.url);
    url.hash = prompt ? `prompt=${encodeURIComponent(prompt)}` : "";
    if (this.openId === null) this.panel.setWidth(this.width);
    this.panel.show({ url: url.href, title: entry.title });
    this.openId = id;
    return { ...entry, url: url.href };
  }

  close() {
    if (this.openId === null) return;
    this.panel.hide();
    this.openId = null;
  }

  /** The user dragged the panel edge. */
  resize(px) {
    this.width = clampWidth(px);
    if (this.openId !== null) this.panel.setWidth(this.width);
    return this.width;
  }

  /** New Identity closes the panel along with every other session. */
  onNewIdentity() {
    this.close();
  }

  /** Entry point for the start page's bridge message. */
  handle(message) {
    if (!message || message.name !== "VEIL:OpenAppPanel") return null;
    const id = message.data && message.data.id;
    if (typeof id !== "string") throw new AppPanelError("message carries no app id");
    return this.toggle(id);
  }
}
