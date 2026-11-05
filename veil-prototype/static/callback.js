"use strict";
if (window.parent !== window) {
  window.parent.postMessage({ veil: "cid-callback", url: location.href }, location.origin);
}
