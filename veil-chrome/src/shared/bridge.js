/* Bridge between a VEIL dashboard page and the browser.
 *
 * In the shipped browser these pages are privileged about: pages, and the
 * 0002 chrome patch exposes Firefox's RemotePageManager functions
 * (RPMSendAsyncMessage / RPMAddMessageListener) to them. Outside the browser
 * (design preview, tests) the bridge falls back to a preview mode that never
 * touches the network.
 *
 * Messages are a fixed allow-list: a dashboard can ask for status and
 * request user-visible actions, nothing else.
 */
"use strict";

const VeilBridge = (() => {
  const OUTGOING = new Set([
    "VEIL:GetTorStatus",
    "VEIL:NewIdentity",
    "VEIL:NewCircuit",
    "VEIL:GetBookmarks",
    "VEIL:OpenSignIn",
    "VEIL:OpenAppPanel",
    "VEIL:GetAccount",
  ]);
  const INCOMING = new Set(["VEIL:TorStatus", "VEIL:Bookmarks", "VEIL:Account"]);

  const native =
    typeof RPMSendAsyncMessage === "function" &&
    typeof RPMAddMessageListener === "function";

  const listeners = new Map();

  function send(name, data = {}) {
    if (!OUTGOING.has(name)) throw new Error(`VEIL bridge: message not allowed: ${name}`);
    if (native) {
      RPMSendAsyncMessage(name, data);
      return;
    }
    preview(name);
  }

  function on(name, fn) {
    if (!INCOMING.has(name)) throw new Error(`VEIL bridge: listener not allowed: ${name}`);
    if (!listeners.has(name)) {
      listeners.set(name, []);
      if (native) RPMAddMessageListener(name, msg => emit(name, msg.data));
    }
    listeners.get(name).push(fn);
  }

  function emit(name, data) {
    for (const fn of listeners.get(name) || []) fn(data);
  }

  // Preview mode: fixed, local answers so the page can be designed and
  // tested in any browser without a VEIL build.
  function preview(name) {
    queueMicrotask(() => {
      if (name === "VEIL:GetTorStatus") emit("VEIL:TorStatus", { state: "preview" });
      if (name === "VEIL:GetBookmarks") emit("VEIL:Bookmarks", { items: [] });
      if (name === "VEIL:GetAccount") emit("VEIL:Account", { signedIn: false });
    });
  }

  return { send, on, native };
})();
