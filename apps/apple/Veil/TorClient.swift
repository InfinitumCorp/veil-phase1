import Foundation
import Network

@MainActor
final class EmbeddedTorClient: ObservableObject {
    @Published private(set) var state: TorConnectionState = .unknown
    @Published private(set) var diagnostics: String = ""
    @Published private(set) var lastControlPlan: TorControlCommandPlan?
    private(set) var socksEndpoint: TorEndpoint?
    let configuration: TorLaunchConfiguration
    let locator: TorBinaryLocator
    private let daemon: any InProcessTorDaemon
    #if os(macOS)
    private var process: Process?
    #endif

    init(
        configuration: TorLaunchConfiguration,
        locator: TorBinaryLocator,
        daemon: any InProcessTorDaemon = NotLinkedTorDaemon()
    ) {
        self.configuration = configuration
        self.locator = locator
        self.daemon = daemon
    }

    static func bundled(configuration: TorLaunchConfiguration, bundle: Bundle = .main) -> EmbeddedTorClient {
        EmbeddedTorClient(configuration: configuration, locator: TorBinaryLocator.current(bundle: bundle))
    }

    var acceptsWebTraffic: Bool {
        guard state == .connected, let socksEndpoint else { return false }
        return AnonymityGuard.isLoopback(socksEndpoint.host)
    }

    func start() async {
        state = .connecting
        socksEndpoint = nil
        if configuration.clientKind == .networkExtension {
            state = .error
            diagnostics = PacketTunnelPlan.unavailable(socks: configuration.socksEndpoint).reason
            return
        }
        if !locator.canSpawnProcess {
            await startInProcess()
            return
        }
        guard let executable = locator.executable(for: configuration.clientKind) else {
            state = .error
            diagnostics = "No Arti or Tor binary is bundled. Browsing stays paused until one is added to the app. VEIL does not fall back to a direct connection."
            return
        }
        await launch(executable)
    }

    func stop() async {
        #if os(macOS)
        process?.terminate()
        process = nil
        #endif
        await daemon.stop()
        socksEndpoint = nil
        if state == .connected {
            state = .error
            diagnostics = VeilCopy.statusError
        }
    }

    func newIdentity() async {
        await signal(.newIdentity)
    }

    func newCircuit(forHost host: String) async {
        await signal(.newCircuit(host: host))
    }

    private func startInProcess() async {
        do {
            let endpoint = try await daemon.start(configuration: configuration)
            guard AnonymityGuard.isLoopback(endpoint.host) else {
                state = .error
                diagnostics = "The Tor daemon offered a non-loopback proxy. VEIL will not use it."
                return
            }
            socksEndpoint = endpoint
            state = .connected
            diagnostics = "In-process Tor daemon is running."
        } catch {
            state = .error
            diagnostics = "This platform cannot spawn a Tor executable, and the in-process Tor.framework / Arti library is not linked. WKWebView will use a SOCKS proxy when a daemon is running. There is no direct connection."
        }
    }

    private func signal(_ command: TorControlCommand) async {
        let plan = TorControlScript.plan(for: command)
        lastControlPlan = plan
        guard state == .connected else {
            diagnostics = "Tor control is unavailable in this build."
            return
        }
        do {
            try await daemon.signal(command)
        } catch {
            diagnostics = "Tor control is unavailable in this build."
        }
    }

    private func launch(_ executable: URL) async {
        #if os(macOS)
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("veil-tor-\(UUID().uuidString)", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let plan = TorLaunchPlan.make(configuration: configuration, directory: directory)
            try plan.configText.write(to: directory.appendingPathComponent(plan.configFileName), atomically: true, encoding: .utf8)
            let process = Process()
            process.executableURL = executable
            process.arguments = plan.arguments
            process.currentDirectoryURL = directory
            try process.run()
            self.process = process
            let open = await Self.portIsOpen(configuration.socksEndpoint)
            guard open, process.isRunning else {
                process.terminate()
                self.process = nil
                state = .error
                socksEndpoint = nil
                diagnostics = "The bundled Tor client exited before its SOCKS port opened. Browsing stays paused."
                return
            }
            socksEndpoint = configuration.socksEndpoint
            state = .connected
            diagnostics = "Started \(executable.lastPathComponent) on \(configuration.socksHost):\(configuration.socksPort)."
        } catch {
            state = .error
            socksEndpoint = nil
            diagnostics = "The bundled Tor client did not start. Browsing stays paused."
        }
        #else
        state = .error
        socksEndpoint = nil
        diagnostics = "This platform cannot launch \(executable.lastPathComponent)."
        #endif
    }

    static func portIsOpen(_ endpoint: TorEndpoint) async -> Bool {
        guard let port = NWEndpoint.Port(rawValue: endpoint.port) else { return false }
        let connection = NWConnection(host: NWEndpoint.Host(endpoint.host), port: port, using: .tcp)
        return await withCheckedContinuation { continuation in
            let gate = ContinuationGate(continuation)
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    gate.resume(true)
                    connection.cancel()
                case .failed, .cancelled:
                    gate.resume(false)
                default:
                    break
                }
            }
            connection.start(queue: .global())
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
                gate.resume(false)
                connection.cancel()
            }
        }
    }
}

/// Resumes a continuation once. The port probe can both succeed and time out.
private final class ContinuationGate: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Bool, Never>?

    init(_ continuation: CheckedContinuation<Bool, Never>) {
        self.continuation = continuation
    }

    func resume(_ value: Bool) {
        lock.lock()
        let current = continuation
        continuation = nil
        lock.unlock()
        current?.resume(returning: value)
    }
}

extension TorBinaryLocator {
    static func current(bundle: Bundle) -> TorBinaryLocator {
        var arti: [URL] = []
        var tor: [URL] = []
        if let url = bundle.url(forAuxiliaryExecutable: "arti") { arti.append(url) }
        if let url = bundle.url(forResource: "arti", withExtension: nil) { arti.append(url) }
        if let url = bundle.url(forAuxiliaryExecutable: "tor") { tor.append(url) }
        if let url = bundle.url(forResource: "tor", withExtension: nil) { tor.append(url) }
        #if os(macOS)
        let canSpawn = true
        #else
        let canSpawn = false
        #endif
        return resolve(
            artiCandidates: arti,
            torCandidates: tor,
            fileExists: { FileManager.default.isExecutableFile(atPath: $0.path) },
            canSpawn: canSpawn
        )
    }
}

/// POST that can only leave through the local Tor SOCKS port.
/// The process-wide shared session is intentionally unused: it would not use that port.
final class ProxiedFormPoster: FormPosting, @unchecked Sendable {
    private let gate: @MainActor () -> TrafficGate

    init(gate: @escaping @MainActor () -> TrafficGate) {
        self.gate = gate
    }

    func post(url: URL, body: String) async throws -> HTTPResult {
        let endpoint = try await MainActor.run { try TorProtectedRequest.validate(url: url, gate: gate()) }
        guard let port = NWEndpoint.Port(rawValue: endpoint.port) else { throw TorClientError.trafficPaused }
        let configuration = URLSessionConfiguration.ephemeral
        var proxy = ProxyConfiguration(socksv5Proxy: NWEndpoint.hostPort(host: NWEndpoint.Host(endpoint.host), port: port))
        proxy.allowFailover = false
        configuration.proxyConfigurations = [proxy]
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.httpShouldSetCookies = false
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.timeoutIntervalForRequest = 30
        let session = URLSession(configuration: configuration)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = Data(body.utf8)
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: request)
        session.finishTasksAndInvalidate()
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        return HTTPResult(status: status, body: data)
    }
}
