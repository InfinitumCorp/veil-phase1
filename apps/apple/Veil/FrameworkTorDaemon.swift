import Foundation
import VeilLogic

/// Starts the Tor thread that Tor.framework links into this process.
/// Unit tests that host the app do not call this: `EmbeddedTorClient.bundled`
/// substitutes the stand-in daemon when XCTest launched the process, so the
/// suite does not open a circuit. A normal launch and UI tests do.
final class FrameworkTorDaemon: InProcessTorDaemon {
    private let session = VeilTorSession()
    private let lock = NSLock()
    private var resume: OnceResume?

    func start(configuration: TorLaunchConfiguration, onUpdate: @escaping (TorDaemonUpdate) -> Void) async throws -> TorDaemonStarted {
        guard LoopbackHost.isLoopback(configuration.socksHost),
              configuration.controlHost == "127.0.0.1",
              configuration.socksPort > 0,
              configuration.controlPort > 0
        else {
            throw TorClientError.failedToStart
        }
        let parent = try Self.runtimeDirectory()
        var fileConfiguration = configuration
        fileConfiguration.clientKind = .torFramework
        let plan = TorLaunchPlan.make(configuration: fileConfiguration, directory: parent)
        let torrc = parent.appendingPathComponent(plan.configFileName)
        try plan.configText.write(to: torrc, atomically: true, encoding: .utf8)
        let dataDirectory = parent.appendingPathComponent(configuration.dataDirectoryName, isDirectory: true)
        try FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dataDirectory.path)
        let endpoint = TorEndpoint(host: configuration.socksHost, port: configuration.socksPort)
        return try await withCheckedThrowingContinuation { continuation in
            let gate = OnceResume(continuation)
            lock.lock()
            resume = gate
            lock.unlock()
            session.start(
                withTorrc: torrc,
                dataDirectory: dataDirectory,
                controlHost: "127.0.0.1",
                controlPort: UInt(configuration.controlPort),
                progress: { progress, summary, circuit, alive in
                    onUpdate(TorDaemonUpdate(
                        progress: Int(progress),
                        summary: summary,
                        circuitEstablished: circuit,
                        threadAlive: alive
                    ))
                },
                completion: { ready, message in
                    if ready {
                        gate.resume(.success(TorDaemonStarted(
                            endpoint: endpoint,
                            readiness: TorReadiness(progress: 100, summary: message, circuitEstablished: true, threadAlive: true)
                        )))
                    } else {
                        onUpdate(TorDaemonUpdate(progress: 0, summary: message, circuitEstablished: false, threadAlive: false))
                        gate.resume(.failure(TorClientError.failedToStart))
                    }
                }
            )
        }
    }

    func stop() async {
        session.shutdown()
    }

    func signal(_ command: TorControlCommand) async throws {
        let lines = TorControlScript.plan(for: command).lines
        for line in lines {
            let ok = await withCheckedContinuation { continuation in
                session.sendCommand(line) { ok in
                    continuation.resume(returning: ok)
                }
            }
            if !ok { throw TorClientError.controlPortUnavailable }
        }
    }

    private static func runtimeDirectory() throws -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let directory = base.appendingPathComponent("VEIL/tor-runtime", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }
}

private final class OnceResume: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<TorDaemonStarted, Error>?

    init(_ continuation: CheckedContinuation<TorDaemonStarted, Error>) {
        self.continuation = continuation
    }

    func resume(_ result: Result<TorDaemonStarted, Error>) {
        lock.lock()
        let current = continuation
        continuation = nil
        lock.unlock()
        current?.resume(with: result)
    }
}
