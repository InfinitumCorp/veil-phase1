import Foundation
@_exported import VeilLogic

enum TorConnectionState: String, Codable, Equatable {
    case unknown
    case connecting
    case connected
    case error
    case blocked
}

enum TorClientKind: String, Codable, Equatable {
    /// Arti, the Tor Project's Rust client. Preferred once a binary is bundled.
    case arti
    /// A `tor` executable, as Tor.framework / iCepa ship it.
    case torFramework
    /// A Packet Tunnel provider. Not installed in this build.
    case networkExtension
}

struct TorEndpoint: Equatable, Codable {
    var host: String
    var port: UInt16
}

struct TorLaunchConfiguration: Equatable, Codable {
    var socksHost: String
    var socksPort: UInt16
    var controlHost: String
    var controlPort: UInt16
    var socksVersion: Int
    var remoteDNS: Bool
    var failoverDirect: Bool
    var httpProxy: String
    var sslProxy: String
    var noProxiesOn: String
    var trrMode: Int
    var proxyType: Int
    var useBridges: Bool
    var bridgeLines: [String]
    var clientKind: TorClientKind
    var dataDirectoryName: String

    static let veilDefault = TorLaunchConfiguration(
        socksHost: "127.0.0.1",
        socksPort: 9150,
        controlHost: "127.0.0.1",
        controlPort: 9151,
        socksVersion: 5,
        remoteDNS: true,
        failoverDirect: false,
        httpProxy: "",
        sslProxy: "",
        noProxiesOn: "",
        trrMode: 5,
        proxyType: 1,
        useBridges: false,
        bridgeLines: [],
        clientKind: .arti,
        dataDirectoryName: "veil-tor"
    )

    var socksEndpoint: TorEndpoint {
        TorEndpoint(host: socksHost, port: socksPort)
    }
}

enum TorBridgeList {
    static func sanitized(_ lines: [String]) -> [String] {
        lines.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter(isBridgeLine)
    }

    static func isBridgeLine(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 500 else { return false }
        let lower = trimmed.lowercased()
        if lower.contains("socksport") || lower.contains("httpproxy") || lower.contains("httpsproxy") { return false }
        if lower.contains("\n") || lower.contains("\r") { return false }
        var body = lower
        if body.hasPrefix("bridge ") { body = String(body.dropFirst("bridge ".count)) }
        if body.range(of: #"^(\d{1,3}\.){3}\d{1,3}:\d{1,5}(\s|$)"#, options: .regularExpression) != nil {
            return true
        }
        let transports = ["obfs4 ", "webtunnel ", "snowflake ", "meek_lite "]
        return transports.contains { body.hasPrefix($0) }
    }
}

enum TorControlCommand: Equatable {
    case newIdentity
    case newCircuit(host: String)
}

struct TorControlCommandPlan: Equatable {
    var lines: [String]
    var isolationHost: String?
}

enum TorControlScript {
    /// Control-port commands. New identity is `SIGNAL NEWNYM`. A new circuit
    /// for one site drops the cached DNS answer and remembers the host; the
    /// live control connection that would close that site's circuits is not
    /// bundled, so nothing here opens a socket.
    static func plan(for command: TorControlCommand) -> TorControlCommandPlan {
        switch command {
        case .newIdentity:
            return TorControlCommandPlan(lines: TorSignals.newIdentity, isolationHost: nil)
        case .newCircuit(let host):
            return TorControlCommandPlan(lines: TorSignals.newCircuit, isolationHost: host)
        }
    }
}

struct WebKitProxyPlan: Equatable {
    var host: String
    var port: UInt16
    var version: Int
    var remoteDNS: Bool
    var allowFailover: Bool

    static func make(endpoint: TorEndpoint, settings: VeilSettings) -> WebKitProxyPlan {
        WebKitProxyPlan(
            host: endpoint.host,
            port: endpoint.port,
            version: settings.tor.socksVersion,
            remoteDNS: settings.tor.remoteDNS,
            allowFailover: false
        )
    }
}

/// What a system-wide proxy change would be. VEIL does not apply it:
/// it would send other apps through Tor and needs a privileged helper.
struct SystemProxyPlan: Equatable {
    var host: String
    var port: UInt16
    var applied: Bool
    var reason: String

    static func notApplied(host: String, port: UInt16) -> SystemProxyPlan {
        SystemProxyPlan(
            host: host,
            port: port,
            applied: false,
            reason: "VEIL sets the proxy on its own WebKit data store. It does not change the system proxy."
        )
    }
}

/// What a Network Extension packet tunnel would do. The appex is not in this
/// project: it needs the Network Extensions entitlement and a provisioning
/// profile, and an unsigned CI build cannot embed it.
struct PacketTunnelPlan: Equatable {
    var installed: Bool
    var socksHost: String
    var socksPort: UInt16
    var reason: String

    static func unavailable(socks: TorEndpoint) -> PacketTunnelPlan {
        PacketTunnelPlan(
            installed: false,
            socksHost: socks.host,
            socksPort: socks.port,
            reason: "Network Extension is not installed. Browsing uses WKWebsiteDataStore proxy configuration when a local Tor SOCKS port is up. A packet tunnel would also cover traffic outside WebKit, and it needs a paid developer account."
        )
    }
}

struct TorLaunchPlan: Equatable {
    var kind: TorClientKind
    var arguments: [String]
    var configText: String
    var configFileName: String

    static func make(configuration: TorLaunchConfiguration, directory: URL) -> TorLaunchPlan {
        let bridges = TorBridgeList.sanitized(configuration.bridgeLines)
        switch configuration.clientKind {
        case .arti:
            return TorLaunchPlan(
                kind: .arti,
                arguments: ["proxy", "--config", directory.appendingPathComponent("arti.toml").path],
                configText: artiToml(configuration, directory: directory, bridges: bridges),
                configFileName: "arti.toml"
            )
        case .torFramework, .networkExtension:
            return TorLaunchPlan(
                kind: configuration.clientKind,
                arguments: ["-f", directory.appendingPathComponent("torrc").path],
                configText: torrc(configuration, directory: directory, bridges: bridges),
                configFileName: "torrc"
            )
        }
    }

    static func artiToml(_ configuration: TorLaunchConfiguration, directory: URL, bridges: [String]) -> String {
        var lines = [
            "# Generated by VEIL. WebKit is pointed at this listener.",
            "# DNS is not published as its own port; names go through SOCKS.",
            "[proxy]",
            "socks_listen = \"\(configuration.socksHost):\(configuration.socksPort)\"",
            "",
            "[address_filter]",
            "allow_onion_addrs = true",
            "",
            "[storage]",
            "cache_dir = \"\(directory.appendingPathComponent(configuration.dataDirectoryName).path)\"",
            "",
        ]
        if configuration.useBridges && !bridges.isEmpty {
            lines.append("# Bridge lines are stored for the Tor daemon.")
            lines.append("# Applying them to Arti waits on the bundled Arti version, whose bridge table differs by release.")
            lines.append("[bridges]")
            lines.append("enabled = false")
            lines.append("")
        }
        return lines.joined(separator: "\n")
    }

    static func torrc(_ configuration: TorLaunchConfiguration, directory: URL, bridges: [String]) -> String {
        var lines = [
            "# Generated by VEIL.",
            "SocksPort \(configuration.socksHost):\(configuration.socksPort) IsolateDestAddr",
            "SocksPolicy accept 127.0.0.1",
            "SocksPolicy accept6 [::1]",
            "SocksPolicy reject *",
            "ControlPort \(configuration.controlHost):\(configuration.controlPort)",
            "CookieAuthentication 1",
            "AvoidDiskWrites 1",
            "ClientOnly 1",
            "SafeLogging 1",
            "DataDirectory \(directory.appendingPathComponent(configuration.dataDirectoryName).path)",
            "Log notice stdout",
        ]
        if configuration.useBridges && !bridges.isEmpty {
            lines.append("UseBridges 1")
            for bridge in bridges {
                let text = bridge.lowercased().hasPrefix("bridge ") ? bridge : "Bridge \(bridge)"
                lines.append(text)
            }
        }
        return lines.joined(separator: "\n") + "\n"
    }
}

struct TorBinaryLocator: Equatable {
    var artiExecutable: URL?
    var torExecutable: URL?
    var canSpawnProcess: Bool

    static let missing = TorBinaryLocator(artiExecutable: nil, torExecutable: nil, canSpawnProcess: true)

    static func resolve(artiCandidates: [URL], torCandidates: [URL], fileExists: (URL) -> Bool, canSpawn: Bool) -> TorBinaryLocator {
        TorBinaryLocator(
            artiExecutable: artiCandidates.first(where: fileExists),
            torExecutable: torCandidates.first(where: fileExists),
            canSpawnProcess: canSpawn
        )
    }

    func executable(for kind: TorClientKind) -> URL? {
        switch kind {
        case .arti: return artiExecutable
        case .torFramework: return torExecutable
        case .networkExtension: return nil
        }
    }
}

enum TorClientError: Error, Equatable {
    case binaryNotBundled
    case platformCannotSpawnProcess
    case daemonNotLinked
    case failedToStart
    case networkExtensionNotInstalled
    case controlPortUnavailable
    case trafficPaused
    case refusedCleartext
}

struct TorDaemonUpdate: Equatable {
    var progress: Int
    var summary: String
    var circuitEstablished: Bool
    var threadAlive: Bool
}

struct TorDaemonStarted: Equatable {
    var endpoint: TorEndpoint
    var readiness: TorReadiness
}

protocol InProcessTorDaemon: AnyObject {
    /// `onUpdate` is called on the main thread, including after `start` returns.
    func start(configuration: TorLaunchConfiguration, onUpdate: @escaping (TorDaemonUpdate) -> Void) async throws -> TorDaemonStarted
    func stop() async
    func signal(_ command: TorControlCommand) async throws
}

/// Stand-in used when this process was launched by XCTest, and by tests that
/// want the fail-closed path without opening a circuit.
final class NotLinkedTorDaemon: InProcessTorDaemon {
    func start(configuration: TorLaunchConfiguration, onUpdate: @escaping (TorDaemonUpdate) -> Void) async throws -> TorDaemonStarted {
        throw TorClientError.daemonNotLinked
    }

    func stop() async {}

    func signal(_ command: TorControlCommand) async throws {
        throw TorClientError.daemonNotLinked
    }
}
