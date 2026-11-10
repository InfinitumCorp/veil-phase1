import Foundation

public struct ProxyRequest: Equatable, Sendable {
    public var host: String
    public var port: UInt16
    public var socksVersion: Int
    public var allowFailover: Bool
    public var excludedDomains: [String]
    public var remoteDNS: Bool
    public var persistentStore: Bool

    public init(host: String, port: UInt16, socksVersion: Int, allowFailover: Bool, excludedDomains: [String], remoteDNS: Bool, persistentStore: Bool) {
        self.host = host
        self.port = port
        self.socksVersion = socksVersion
        self.allowFailover = allowFailover
        self.excludedDomains = excludedDomains
        self.remoteDNS = remoteDNS
        self.persistentStore = persistentStore
    }
}

public enum WebDataPolicy {
    /// WebKit storage stays in memory unless a future setting says otherwise.
    public static let persistentByDefault = false
}

public enum ProxyInstall {
    /// Nil means do not install a proxy and do not load a page.
    /// SOCKS5 on this device, remote DNS, no failover, no bypass list, and a non-persistent store.
    public static func request(
        readiness: TorReadiness,
        host: String,
        port: UInt16,
        socksVersion: Int,
        remoteDNS: Bool,
        allowFailover: Bool,
        excludedDomains: [String],
        persistentStore: Bool
    ) -> ProxyRequest? {
        guard readiness.acceptsTraffic else { return nil }
        let trimmedHost = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard LoopbackHost.isLoopback(trimmedHost) else { return nil }
        guard port > 0 else { return nil }
        guard socksVersion == 5 else { return nil }
        guard remoteDNS else { return nil }
        guard allowFailover == false else { return nil }
        let exclusions = excludedDomains.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        guard exclusions.isEmpty else { return nil }
        guard persistentStore == false else { return nil }
        return ProxyRequest(
            host: trimmedHost,
            port: port,
            socksVersion: 5,
            allowFailover: false,
            excludedDomains: [],
            remoteDNS: true,
            persistentStore: false
        )
    }
}
