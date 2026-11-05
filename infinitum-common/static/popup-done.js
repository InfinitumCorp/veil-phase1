// Sign-in popup finished: tell the app in VEIL's side panel, then close.
"use strict";
try { new BroadcastChannel("infinitum-auth").postMessage({ type: "infinitum:signed-in" }); } catch { /* old browser */ }
if (window.opener && !window.opener.closed) {
  window.opener.postMessage({ type: "infinitum:signed-in" }, location.origin);
}
window.close();
// If the window can't close itself, show the app instead.
setTimeout(() => location.replace("/"), 300);
