import Foundation

/// Assertions shared by the Linux package tests and the Mac app tests.
public enum TorLogicChecks {
    public struct Failure: Error, CustomStringConvertible, Equatable {
        public var message: String
        public var description: String { message }
        public init(_ message: String) { self.message = message }
    }

    public static func run() throws {
        try checkParser()
        try checkReadinessGate()
        try checkProxy()
        try checkStatusLine()
        try checkSignals()
        try checkLeakScript()
        try checkDataPolicy()
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() { throw Failure(message) }
    }

    private static func checkParser() throws {
        let line = "STATUS_CLIENT NOTICE BOOTSTRAP PROGRESS=15 TAG=handshake SUMMARY=\"Handshaking with a relay\""
        let status = try unwrap(TorControlStatusParser.parse(line), "bootstrap line")
        try expect(status.type == "STATUS_CLIENT", "type")
        try expect(status.action == "BOOTSTRAP", "action")
        try expect(status.arguments["PROGRESS"] == "15", "progress")
        try expect(status.arguments["SUMMARY"] == "Handshaking with a relay", "summary keeps spaces")
        try expect(TorControlStatusParser.parse("NOTICE only") == nil, "short line")
    }

    private static func checkReadinessGate() throws {
        var readiness = TorReadiness.booting
        try expect(!readiness.acceptsTraffic, "boot does not accept traffic")
        let early = try unwrap(TorControlStatusParser.parse("STATUS_CLIENT NOTICE BOOTSTRAP PROGRESS=40 TAG=loading_descriptors SUMMARY=\"Loading relay descriptors\""), "40")
        readiness = TorReadinessReducer.apply(status: early, to: readiness)
        try expect(readiness.progress == 40, "progress 40")
        try expect(readiness.summary == "Loading relay descriptors", "summary")
        try expect(!readiness.acceptsTraffic, "progress without a circuit stays closed")
        let done = try unwrap(TorControlStatusParser.parse("STATUS_CLIENT NOTICE BOOTSTRAP PROGRESS=100 TAG=done SUMMARY=\"Done\""), "100")
        readiness = TorReadinessReducer.apply(status: done, to: readiness)
        try expect(!readiness.acceptsTraffic, "100 percent without a circuit stays closed")
        let up = try unwrap(TorControlStatusParser.parse("STATUS_CLIENT NOTICE CIRCUIT_ESTABLISHED"), "up")
        readiness = TorReadinessReducer.apply(status: up, to: readiness)
        try expect(readiness.acceptsTraffic, "circuit opens the gate")
        try expect(readiness.progress == 100, "circuit implies bootstrap finished")
        let down = try unwrap(TorControlStatusParser.parse("STATUS_CLIENT NOTICE CIRCUIT_NOT_ESTABLISHED REASON=TIMEOUT"), "down")
        readiness = TorReadinessReducer.apply(status: down, to: readiness)
        try expect(!readiness.circuitEstablished, "drop clears the circuit")
        try expect(!readiness.acceptsTraffic, "a dropped circuit closes the gate")
        readiness = TorReadinessReducer.apply(status: up, to: readiness)
        try expect(readiness.acceptsTraffic, "circuit can return")
        let dead = TorReadinessReducer.apply(status: up, threadAlive: false, to: readiness)
        try expect(!dead.threadAlive, "thread death is recorded")
        try expect(!dead.acceptsTraffic, "a dead Tor thread closes the gate")
        let ignored = TorReadinessReducer.apply(
            status: TorControlStatus(type: "STATUS_SERVER", severity: "NOTICE", action: "EXTERNAL_ADDRESS", arguments: [:]),
            to: TorReadiness.booting
        )
        try expect(ignored == TorReadiness.booting, "unrelated status does not open the gate")
    }

    private static func checkProxy() throws {
        let ready = TorReadiness(progress: 100, summary: "Done", circuitEstablished: true, threadAlive: true)
        let installed = try unwrap(proxy(ready, host: "127.0.0.1"), "loopback proxy")
        try expect(installed.host == "127.0.0.1", "host")
        try expect(installed.port == 9150, "port")
        try expect(installed.socksVersion == 5, "socks5")
        try expect(installed.allowFailover == false, "no failover")
        try expect(installed.excludedDomains.isEmpty, "no bypass list")
        try expect(installed.remoteDNS, "remote DNS")
        try expect(installed.persistentStore == false, "memory store")
        try expect(proxy(ready, host: "localhost") != nil, "localhost")
        try expect(proxy(ready, host: "::1") != nil, "ipv6 loopback")
        try expect(proxy(ready, host: "[::1]") != nil, "bracketed ipv6")
        try expect(proxy(ready, host: "203.0.113.5") == nil, "public proxy is refused")
        try expect(proxy(TorReadiness.booting, host: "127.0.0.1") == nil, "not bootstrapped")
        try expect(proxy(TorReadiness(progress: 100, summary: "", circuitEstablished: false, threadAlive: true), host: "127.0.0.1") == nil, "no circuit")
        try expect(proxy(TorReadiness(progress: 40, summary: "", circuitEstablished: true, threadAlive: true), host: "127.0.0.1") == nil, "partial bootstrap")
        try expect(proxy(TorReadiness(progress: 100, summary: "", circuitEstablished: true, threadAlive: false), host: "127.0.0.1") == nil, "thread stopped")
        try expect(proxy(ready, host: "127.0.0.1", socksVersion: 4) == nil, "socks4")
        try expect(proxy(ready, host: "127.0.0.1", remoteDNS: false) == nil, "local DNS")
        try expect(proxy(ready, host: "127.0.0.1", allowFailover: true) == nil, "failover")
        try expect(proxy(ready, host: "127.0.0.1", excludedDomains: ["example.com"]) == nil, "bypass")
        try expect(proxy(ready, host: "127.0.0.1", persistentStore: true) == nil, "disk store")
        try expect(proxy(ready, host: "127.0.0.1", port: 0) == nil, "port 0")
        let dropped = TorReadinessReducer.apply(
            status: try unwrap(TorControlStatusParser.parse("STATUS_CLIENT NOTICE CIRCUIT_NOT_ESTABLISHED"), "drop"),
            to: ready
        )
        try expect(proxy(dropped, host: "127.0.0.1") == nil, "proxy comes out when the circuit drops")
    }

    private static func checkStatusLine() throws {
        try expect(TorStatusLine.connecting("Connecting to Tor…", progress: 0) == "Connecting to Tor…", "no percent yet")
        try expect(TorStatusLine.connecting("Connecting to Tor…", progress: 40) == "Connecting to Tor… 40%", "percent")
        try expect(TorStatusLine.connecting("Connecting to Tor…", progress: 140) == "Connecting to Tor… 100%", "clamped")
        try expect(!TorStatusLine.connecting("Connecting to Tor…", progress: 40).contains("Connected to Tor"), "progress is not connected")
    }

    private static func checkSignals() throws {
        try expect(TorSignals.newIdentity == ["SIGNAL CLEARDNSCACHE", "SIGNAL NEWNYM"], "NEWNYM")
        try expect(TorSignals.newCircuit == ["SIGNAL CLEARDNSCACHE"], "new circuit")
        try expect(!TorSignals.newCircuit.contains { $0.contains("example.com") }, "host is not sent on the control port as a site name in the signal")
    }

    private static func checkLeakScript() throws {
        let script = LeakBlock.userScript
        try expect(LeakBlock.isLocal(script), "script does not open a connection")
        for name in ["RTCPeerConnection", "webkitRTCPeerConnection", "getUserMedia", "dns-prefetch", "preconnect"] {
            try expect(script.contains(name), name)
        }
        try expect(WebDataPolicy.persistentByDefault == false, "store policy")
    }

    private static func checkDataPolicy() throws {
        try expect(WebDataPolicy.persistentByDefault == false, "non-persistent by default")
    }

    private static func proxy(
        _ readiness: TorReadiness,
        host: String,
        port: UInt16 = 9150,
        socksVersion: Int = 5,
        remoteDNS: Bool = true,
        allowFailover: Bool = false,
        excludedDomains: [String] = [],
        persistentStore: Bool = false
    ) -> ProxyRequest? {
        ProxyInstall.request(
            readiness: readiness,
            host: host,
            port: port,
            socksVersion: socksVersion,
            remoteDNS: remoteDNS,
            allowFailover: allowFailover,
            excludedDomains: excludedDomains,
            persistentStore: persistentStore
        )
    }

    private static func unwrap<T>(_ value: T?, _ message: String) throws -> T {
        if let value { return value }
        throw Failure(message)
    }
}
