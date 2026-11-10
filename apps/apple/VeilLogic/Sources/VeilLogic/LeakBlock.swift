import Foundation

public enum LeakBlock {
    /// Runs in the page before other scripts. It disables WebRTC, which can
    /// reveal a local address, and drops DNS prefetch hints. It does not
    /// itself open a connection.
    public static let userScript = """
    (function () {
      function reject() { return Promise.reject(new Error("blocked")); }
      function Blocked() { throw new Error("blocked"); }
      var names = ["RTCPeerConnection", "webkitRTCPeerConnection", "mozRTCPeerConnection", "RTCDataChannel", "RTCIceCandidate", "RTCSessionDescription"];
      for (var i = 0; i < names.length; i++) {
        try {
          Object.defineProperty(window, names[i], { configurable: false, writable: false, value: Blocked });
        } catch (e) {}
      }
      if (navigator.mediaDevices) {
        try { navigator.mediaDevices.getUserMedia = reject; } catch (e) {}
        try { navigator.mediaDevices.getDisplayMedia = reject; } catch (e) {}
      }
      function strip(node) {
        if (!node || !node.querySelectorAll) return;
        var links = node.querySelectorAll('link[rel~="dns-prefetch"],link[rel~="preconnect"]');
        for (var j = 0; j < links.length; j++) {
          if (links[j].parentNode) links[j].parentNode.removeChild(links[j]);
        }
      }
      function arm() {
        strip(document);
        if (!window.MutationObserver || !document.documentElement) return;
        var observer = new MutationObserver(function (records) {
          for (var i = 0; i < records.length; i++) {
            var added = records[i].addedNodes;
            for (var j = 0; j < added.length; j++) strip(added[j]);
          }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
      }
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", arm);
      } else {
        arm();
      }
    })();
    """

    public static func isLocal(_ source: String) -> Bool {
        let forbidden = ["fetch(", "XMLHttpRequest", "WebSocket", "sendBeacon", "EventSource", "import("]
        return forbidden.allSatisfy { !source.contains($0) }
    }
}
