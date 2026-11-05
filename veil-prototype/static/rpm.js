// Prototype stand-in for the browser bridge (RPMSendAsyncMessage /
// RPMAddMessageListener) that the real VEIL start page gets from the
// browser. Here, messages go to the prototype shell that frames this page.
"use strict";
(() => {
  if (window.parent === window) return;      // opened on its own: stay in preview mode
  const listeners = new Map();
  window.addEventListener("message", e => {
    if (e.source !== window.parent || e.origin !== location.origin) return;
    const m = e.data;
    if (!m || m.veil !== "rpm-reply") return;
    for (const fn of listeners.get(m.name) || []) fn({ data: m.data });
  });
  window.RPMSendAsyncMessage = (name, data) =>
    window.parent.postMessage({ veil: "rpm", name, data: data || {} }, location.origin);
  window.RPMAddMessageListener = (name, fn) => {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push(fn);
  };
})();
