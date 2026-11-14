import Foundation
import VeilLogic

/// Fingerprinting reductions WebKit actually allows. VEIL does not pretend
/// to be desktop Tor Browser: on iOS the engine is WebKit, and a mismatched
/// user agent would make this app easier to single out, not harder.
struct WebPrivacyPlan: Equatable {
    var persistentStore: Bool
    var javascriptCanOpenWindowsAutomatically: Bool
    var fraudulentWebsiteWarning: Bool
    var siteSpecificQuirks: Bool
    var elementFullscreen: Bool
    var mediaPlaybackRequiresUserAction: Bool
    var customUserAgent: String?
    var referrerScript: String
    var leakScript: String

    static let veil = WebPrivacyPlan(
        persistentStore: WebDataPolicy.persistentByDefault,
        javascriptCanOpenWindowsAutomatically: false,
        fraudulentWebsiteWarning: true,
        siteSpecificQuirks: false,
        elementFullscreen: false,
        mediaPlaybackRequiresUserAction: true,
        customUserAgent: nil,
        referrerScript: """
        (function () {
          var meta = document.createElement("meta");
          meta.name = "referrer";
          meta.content = "no-referrer";
          var root = document.head || document.documentElement;
          if (root) root.appendChild(meta);
        })();
        """,
        leakScript: LeakBlock.userScript
    )

    /// The script must not be able to phone home by itself.
    static func scriptIsLocal(_ source: String) -> Bool {
        LeakBlock.isLocal(source)
    }
}
