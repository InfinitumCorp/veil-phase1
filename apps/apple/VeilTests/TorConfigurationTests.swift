import XCTest
@testable import Veil

final class TorConfigurationTests: XCTestCase {
    func testDefaultProxyIsLoopbackSOCKSWithoutABypass() {
        let tor = TorLaunchConfiguration.veilDefault
        XCTAssertTrue(AnonymityGuard.assess(VeilSettings.veilDefault).isEmpty)
        XCTAssertEqual(tor.socksVersion, 5)
        XCTAssertTrue(tor.remoteDNS)
        XCTAssertFalse(tor.failoverDirect)
        XCTAssertEqual(tor.httpProxy, "")
        XCTAssertEqual(tor.sslProxy, "")
        XCTAssertEqual(tor.noProxiesOn, "")
        XCTAssertTrue(AnonymityGuard.isLoopback(tor.socksHost))
        var broken = VeilSettings.veilDefault
        broken.tor.socksHost = ""
        broken.tor.socksVersion = 4
        broken.tor.remoteDNS = false
        broken.tor.failoverDirect = true
        broken.tor.httpProxy = "10.0.0.1"
        broken.tor.sslProxy = "10.0.0.2"
        broken.tor.noProxiesOn = "example.com"
        broken.tor.trrMode = 2
        broken.tor.proxyType = 0
        broken.tor.socksHost = "203.0.113.5"
        let prefs = Set(AnonymityGuard.assess(broken).map(\.pref))
        for pref in [
            "network.proxy.type", "network.proxy.socks_version", "network.proxy.socks_remote_dns",
            "network.proxy.failover_direct", "network.proxy.http", "network.proxy.ssl",
            "network.proxy.no_proxies_on", "network.trr.mode", "veil.socks_loopback",
        ] {
            XCTAssertTrue(prefs.contains(pref), pref)
        }
    }

    func testTorrcAndArtiConfigStayOnLoopback() {
        let directory = URL(fileURLWithPath: "/tmp/veil-tor", isDirectory: true)
        var configuration = TorLaunchConfiguration.veilDefault
        configuration.useBridges = true
        configuration.bridgeLines = [
            "obfs4 192.0.2.10:443 fingerprint",
            "SocksPort 203.0.113.8:9050",
            "Bridge 198.51.100.4:9001",
        ]
        let arti = TorLaunchPlan.make(configuration: configuration, directory: directory)
        XCTAssertEqual(arti.kind, .arti)
        XCTAssertTrue(arti.configText.contains("socks_listen = \"127.0.0.1:9150\""))
        XCTAssertTrue(arti.configText.contains("allow_onion_addrs = true"))
        XCTAssertFalse(arti.configText.contains("dns_listen"))
        XCTAssertTrue(arti.configText.contains("enabled = false"))
        XCTAssertEqual(arti.arguments.first, "proxy")
        configuration.clientKind = .torFramework
        let tor = TorLaunchPlan.make(configuration: configuration, directory: directory)
        XCTAssertTrue(tor.configText.contains("SocksPort 127.0.0.1:9150 IsolateDestAddr"))
        XCTAssertTrue(tor.configText.contains("SocksPolicy reject *"))
        XCTAssertTrue(tor.configText.contains("CookieAuthentication 1"))
        XCTAssertFalse(tor.configText.contains("HashedControlPassword"))
        XCTAssertTrue(tor.configText.contains("UseBridges 1"))
        XCTAssertTrue(tor.configText.contains("obfs4 192.0.2.10:443 fingerprint"))
        XCTAssertFalse(tor.configText.contains("203.0.113.8"))
        XCTAssertFalse(TorBridgeList.isBridgeLine("SocksPort 203.0.113.8:9050"))
    }

    func testPlansThatAreNotApplied() {
        let endpoint = TorEndpoint(host: "127.0.0.1", port: 9150)
        let system = SystemProxyPlan.notApplied(host: endpoint.host, port: endpoint.port)
        XCTAssertFalse(system.applied)
        let tunnel = PacketTunnelPlan.unavailable(socks: endpoint)
        XCTAssertFalse(tunnel.installed)
        XCTAssertTrue(tunnel.reason.contains("Network Extension"))
        let proxy = WebKitProxyPlan.make(endpoint: endpoint, settings: .veilDefault)
        XCTAssertEqual(proxy.version, 5)
        XCTAssertTrue(proxy.remoteDNS)
        XCTAssertFalse(proxy.allowFailover)
        let identity = TorControlScript.plan(for: .newIdentity)
        XCTAssertEqual(identity.lines, ["SIGNAL CLEARDNSCACHE", "SIGNAL NEWNYM"])
        let circuit = TorControlScript.plan(for: .newCircuit(host: "example.com"))
        XCTAssertFalse(circuit.lines.contains { $0.contains("example.com") })
        XCTAssertEqual(circuit.isolationHost, "example.com")
    }

    func testGateFailsClosed() {
        let endpoint = TorEndpoint(host: "127.0.0.1", port: 9150)
        guard case .allowed(let allowed) = TrafficGate.evaluate(settings: .veilDefault, torState: .connected, endpoint: endpoint) else {
            return XCTFail("connected loopback should pass")
        }
        XCTAssertEqual(allowed, endpoint)
        guard case .paused = TrafficGate.evaluate(settings: .veilDefault, torState: .error, endpoint: nil) else {
            return XCTFail("missing Tor pauses browsing")
        }
        guard case .blocked = TrafficGate.evaluate(settings: .veilDefault, torState: .connected, endpoint: TorEndpoint(host: "203.0.113.5", port: 9050)) else {
            return XCTFail("a remote proxy is not Tor on this device")
        }
        XCTAssertEqual(TorStatusText.text(torState: .error, problems: []), VeilCopy.statusError)
        XCTAssertEqual(TorStatusText.text(torState: .connected, problems: [AnonymityProblem(pref: "veil.https_only", why: "cleartext http stays off")]), VeilCopy.statusBlocked)
    }

    func testProtectedRequestsRequireTheLoopbackGate() {
        let endpoint = TorEndpoint(host: "127.0.0.1", port: 9150)
        let allowed = TrafficGate.allowed(endpoint)
        XCTAssertNoThrow(try TorProtectedRequest.validate(url: URL(string: "https://id.example/token")!, gate: allowed))
        XCTAssertThrowsError(try TorProtectedRequest.validate(url: URL(string: "http://id.example/token")!, gate: allowed))
        XCTAssertThrowsError(try TorProtectedRequest.validate(url: URL(string: "https://id.example/token")!, gate: .paused("down")))
        XCTAssertThrowsError(try TorProtectedRequest.validate(url: URL(string: "https://id.example/token")!, gate: .allowed(TorEndpoint(host: "203.0.113.5", port: 9050))))
    }

    @MainActor
    func testMissingBinaryNeverOpensAProxy() async {
        let client = EmbeddedTorClient(configuration: .veilDefault, locator: .missing)
        await client.start()
        XCTAssertEqual(client.state, .error)
        XCTAssertNil(client.socksEndpoint)
        XCTAssertFalse(client.acceptsWebTraffic)
        XCTAssertTrue(client.diagnostics.contains("bundled"))
        await client.newIdentity()
        XCTAssertEqual(client.lastControlPlan?.lines.last, "SIGNAL NEWNYM")
    }

    @MainActor
    func testNetworkExtensionAndInProcessDaemon() async {
        var configuration = TorLaunchConfiguration.veilDefault
        configuration.clientKind = .networkExtension
        let extensionClient = EmbeddedTorClient(
            configuration: configuration,
            locator: TorBinaryLocator(artiExecutable: URL(fileURLWithPath: "/usr/bin/true"), torExecutable: nil, canSpawnProcess: true)
        )
        await extensionClient.start()
        XCTAssertEqual(extensionClient.state, .error)
        XCTAssertNil(extensionClient.socksEndpoint)
        XCTAssertTrue(extensionClient.diagnostics.contains("Network Extension"))

        let unavailable = EmbeddedTorClient(
            configuration: .veilDefault,
            locator: TorBinaryLocator(artiExecutable: nil, torExecutable: nil, canSpawnProcess: false)
        )
        await unavailable.start()
        XCTAssertEqual(unavailable.state, .error)
        XCTAssertNil(unavailable.socksEndpoint)

        let linked = EmbeddedTorClient(
            configuration: .veilDefault,
            locator: TorBinaryLocator(artiExecutable: nil, torExecutable: nil, canSpawnProcess: false),
            daemon: LoopbackDaemon()
        )
        await linked.start()
        XCTAssertEqual(linked.state, .connected)
        XCTAssertEqual(linked.socksEndpoint, TorEndpoint(host: "127.0.0.1", port: 9150))
        XCTAssertTrue(linked.acceptsWebTraffic)

        let remote = EmbeddedTorClient(
            configuration: .veilDefault,
            locator: TorBinaryLocator(artiExecutable: nil, torExecutable: nil, canSpawnProcess: false),
            daemon: RemoteDaemon()
        )
        await remote.start()
        XCTAssertEqual(remote.state, .error)
        XCTAssertNil(remote.socksEndpoint)
    }

    @MainActor
    func testPKCEVectorAndCumulusConfig() async throws {
        XCTAssertEqual(
            PKCE.challenge(for: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        )
        XCTAssertThrowsError(try CumulusConfigReader.read(["signin": ["cid": ["issuer": "http://id.example"]]]))
        let cid: [String: Any] = [
            "issuer": "https://id.cumulus.example",
            "authorize_url": "https://id.cumulus.example/authorize",
            "token_url": "https://id.cumulus.example/token",
            "client_id": "veil-browser",
            "redirect_uri": "https://id.cumulus.example/veil/callback",
        ]
        let config = try XCTUnwrap(try CumulusConfigReader.read(["signin": ["cid": cid]]))
        XCTAssertEqual(config.clientID, "veil-browser")
        XCTAssertThrowsError(try CumulusConfigReader.read(["signin": ["cid": cid.merging(["issuer": "http://localhost/"]) { $1 }]]))
        let allowed = try XCTUnwrap(try CumulusConfigReader.read(["signin": ["cid": cid.merging(["issuer": "http://localhost/"]) { $1 }]], allowLoopbackHTTP: true))
        XCTAssertEqual(allowed.issuer.host, "localhost")

        let poster = FakePoster()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let session = CumulusSession(
            registryJSON: ["signin": ["cid": cid]],
            fetcher: poster,
            now: { now },
            random: { "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk" }
        )
        let authorize = try session.authorizeURL()
        let items = URLComponents(url: authorize, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
        XCTAssertEqual(value("response_type"), "code")
        XCTAssertEqual(value("client_id"), "veil-browser")
        XCTAssertEqual(value("scope"), "openid profile")
        XCTAssertEqual(value("code_challenge_method"), "S256")
        XCTAssertEqual(value("code_challenge"), PKCE.challenge(for: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
        let nonce = try XCTUnwrap(value("nonce"))
        let state = try XCTUnwrap(value("state"))
        let claims: [String: Any] = [
            "iss": "https://id.cumulus.example",
            "aud": "veil-browser",
            "sub": "user-1",
            "name": "Ada Lovelace",
            "exp": Int(now.timeIntervalSince1970) + 3600,
            "iat": Int(now.timeIntervalSince1970),
            "nonce": nonce,
        ]
        poster.result = HTTPResult(status: 200, body: try JSONSerialization.data(withJSONObject: ["id_token": jwt(claims), "access_token": "at"]))
        let redirect = URL(string: "https://id.cumulus.example/veil/callback?code=abc&state=\(state)")!
        let account = try await session.handleRedirect(redirect, gate: .allowed(TorEndpoint(host: "127.0.0.1", port: 9150)))
        XCTAssertEqual(account.name, "Ada Lovelace")
        XCTAssertTrue(session.signedIn())
        XCTAssertEqual(poster.lastURL?.host, "id.cumulus.example")
        session.forget()
        XCTAssertFalse(session.signedIn())
        let wrong = claims.merging(["iss": "https://evil.example"]) { $1 }
        XCTAssertThrowsError(try IDTokenClaims.check(wrong, issuer: config.issuerString, clientID: config.clientID, nonce: nonce, nowS: now.timeIntervalSince1970))
    }
}

private func jwt(_ claims: [String: Any]) throws -> String {
    let header = Base64URL.encode(Data(#"{"alg":"RS256"}"#.utf8))
    let body = Base64URL.encode(try JSONSerialization.data(withJSONObject: claims))
    return "\(header).\(body).sig"
}

private final class FakePoster: FormPosting {
    var result = HTTPResult(status: 200, body: Data())
    var lastURL: URL?
    func post(url: URL, body: String) async throws -> HTTPResult {
        lastURL = url
        return result
    }
}

private final class LoopbackDaemon: InProcessTorDaemon {
    func start(configuration: TorLaunchConfiguration) async throws -> TorEndpoint {
        TorEndpoint(host: "127.0.0.1", port: 9150)
    }
    func stop() async {}
    func signal(_ command: TorControlCommand) async throws {}
}

private final class RemoteDaemon: InProcessTorDaemon {
    func start(configuration: TorLaunchConfiguration) async throws -> TorEndpoint {
        TorEndpoint(host: "203.0.113.5", port: 9050)
    }
    func stop() async {}
    func signal(_ command: TorControlCommand) async throws { throw TorClientError.daemonNotLinked }
}
