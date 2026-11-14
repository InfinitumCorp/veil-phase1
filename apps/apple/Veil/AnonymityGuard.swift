import Foundation
import VeilLogic

/// VEIL's anonymity guard, applied to this app's own proxy settings.
/// The preference names and the safe values match
/// `veil-browser/src/VeilAnonymityGuard.sys.mjs`. One extra rule covers
/// HTTPS-only, which Firefox expresses as a different preference.
struct AnonymityProblem: Equatable {
    var pref: String
    var why: String
}

enum AnonymityGuard {
    static func assess(_ settings: VeilSettings) -> [AnonymityProblem] {
        let tor = settings.tor
        var problems: [AnonymityProblem] = []
        func check(_ pref: String, _ ok: Bool, _ why: String) {
            if !ok { problems.append(AnonymityProblem(pref: pref, why: why)) }
        }
        check("network.proxy.type", tor.proxyType == 1, "the proxy must be set manually to Tor (type 1)")
        check("network.proxy.socks", !tor.socksHost.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "a Tor SOCKS proxy must be configured")
        check("network.proxy.socks_version", tor.socksVersion == 5, "SOCKS version must be 5")
        check("network.proxy.socks_remote_dns", tor.remoteDNS, "DNS lookups must go through Tor")
        check("network.proxy.failover_direct", tor.failoverDirect == false, "the browser must never fall back to a direct connection")
        check("network.proxy.http", tor.httpProxy.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "no HTTP proxy may bypass Tor")
        check("network.proxy.ssl", tor.sslProxy.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "no HTTPS proxy may bypass Tor")
        check("network.proxy.no_proxies_on", tor.noProxiesOn.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "no site may be excluded from Tor")
        check("network.trr.mode", tor.trrMode == 0 || tor.trrMode == 5, "DNS over HTTPS must stay off; Tor resolves names")
        check("veil.socks_loopback", isLoopback(tor.socksHost), "the Tor SOCKS proxy must be on this device")
        check("veil.https_only", settings.httpsOnly, "cleartext http stays off")
        if tor.useBridges {
            let rejected = tor.bridgeLines.filter { !TorBridgeList.isBridgeLine($0) }
            check("veil.bridges", rejected.isEmpty, "a bridge line cannot change proxy settings")
        }
        return problems
    }

    static func isLoopback(_ host: String) -> Bool {
        LoopbackHost.isLoopback(host)
    }
}

enum TrafficGate: Equatable {
    case allowed(TorEndpoint)
    case paused(String)
    case blocked([AnonymityProblem])

    var allowsLoads: Bool {
        if case .allowed = self { return true }
        return false
    }

    static func evaluate(settings: VeilSettings, torState: TorConnectionState, endpoint: TorEndpoint?) -> TrafficGate {
        let problems = AnonymityGuard.assess(settings)
        if !problems.isEmpty {
            return .blocked(problems)
        }
        guard torState == .connected, let endpoint else {
            return .paused(VeilCopy.statusError)
        }
        // A proxy that is not on this device is not our Tor: refuse it outright
        // instead of waiting for it to come back.
        guard AnonymityGuard.isLoopback(endpoint.host) else {
            return .blocked([AnonymityProblem(pref: "veil.socks_host", why: "the Tor SOCKS port must be on this device (loopback)")])
        }
        return .allowed(endpoint)
    }
}

enum TorStatusText {
    static func text(torState: TorConnectionState, problems: [AnonymityProblem], progress: Int = 0) -> String {
        if !problems.isEmpty || torState == .blocked {
            return VeilCopy.statusBlocked
        }
        switch torState {
        case .unknown: return VeilCopy.statusChecking
        case .connecting: return TorStatusLine.connecting(VeilCopy.statusConnecting, progress: progress)
        case .connected: return VeilCopy.statusConnected
        case .error: return VeilCopy.statusError
        case .blocked: return VeilCopy.statusBlocked
        }
    }
}
