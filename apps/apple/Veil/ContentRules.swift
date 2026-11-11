import Foundation

/// Tracker and ad blocking compiled into a `WKContentRuleList`.
/// The host list is VEIL's, written for this app. It is not a copy of a
/// third-party blocklist. Blocking fails open (a page can still load);
/// Tor never does.
enum ContentRules {
    static let identifier = "app.infinitumveil.browser.blockers"

    /// Hosts that are blocked for every resource type, including documents.
    static let trackerHosts = [
        "doubleclick.net",
        "google-analytics.com",
        "googletagmanager.com",
        "googlesyndication.com",
        "googleadservices.com",
        "adservice.google.com",
        "pagead2.googlesyndication.com",
        "connect.facebook.net",
        "scorecardresearch.com",
        "adnxs.com",
        "adsrvr.org",
        "criteo.com",
        "criteo.net",
        "hotjar.com",
        "mixpanel.com",
        "segment.io",
        "segment.com",
        "amplitude.com",
        "fullstory.com",
        "mouseflow.com",
        "crazyegg.com",
        "quantserve.com",
        "taboola.com",
        "outbrain.com",
        "moatads.com",
        "amazon-adsystem.com",
        "ads.twitter.com",
        "analytics.twitter.com",
        "bat.bing.com",
        "mc.yandex.ru",
        "fingerprintjs.com",
        "cdn.fpjs.io",
    ]

    struct Rule: Equatable {
        var urlFilter: String
        var action: String
        var loadTypes: [String]
    }

    static func rules() -> [Rule] {
        var list = [
            Rule(urlFilter: ".*", action: "block-cookies", loadTypes: ["third-party"]),
        ]
        for host in trackerHosts {
            for filter in filters(for: host) {
                list.append(Rule(urlFilter: filter, action: "block", loadTypes: []))
            }
        }
        return list
    }

    static func filters(for host: String) -> [String] {
        let escaped = host.replacingOccurrences(of: ".", with: "\\.")
        let stem = "https?://([^/]*\\.)?\(escaped)"
        return [
            stem + "/",
            stem + "[^A-Za-z0-9.\\-]",
        ]
    }

    static func jsonData() throws -> Data {
        let objects: [[String: Any]] = rules().map { rule in
            var trigger: [String: Any] = [
                "url-filter": rule.urlFilter,
                "url-filter-is-case-sensitive": false,
            ]
            if !rule.loadTypes.isEmpty {
                trigger["load-type"] = rule.loadTypes
            }
            return [
                "trigger": trigger,
                "action": ["type": rule.action],
            ]
        }
        return try JSONSerialization.data(withJSONObject: objects, options: [.sortedKeys])
    }

    static func jsonString() throws -> String {
        String(decoding: try jsonData(), as: UTF8.self)
    }

    /// Whether one of our filters matches this URL. Used by tests and as a
    /// readable form of the same patterns WebKit compiles.
    static func blocks(_ url: URL) -> Bool {
        let absolute = url.absoluteString
        for host in trackerHosts {
            for filter in filters(for: host) {
                guard let expression = try? NSRegularExpression(pattern: filter, options: [.caseInsensitive]) else { continue }
                let range = NSRange(absolute.startIndex..., in: absolute)
                if expression.firstMatch(in: absolute, options: [], range: range) != nil {
                    return true
                }
            }
        }
        return false
    }
}
