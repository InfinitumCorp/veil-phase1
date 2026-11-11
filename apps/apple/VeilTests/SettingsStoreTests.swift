import XCTest
@testable import Veil

final class SettingsStoreTests: XCTestCase {
    func testDefaultsArePrivate() {
        let settings = VeilSettings.veilDefault
        XCTAssertTrue(settings.wipeOnClose)
        XCTAssertTrue(settings.httpsOnly)
        XCTAssertTrue(settings.allowOnionHTTP)
        XCTAssertEqual(settings.tor.socksHost, "127.0.0.1")
        XCTAssertEqual(settings.tor.socksPort, 9150)
        XCTAssertEqual(settings.tor.socksVersion, 5)
        XCTAssertTrue(settings.tor.remoteDNS)
        XCTAssertFalse(settings.tor.failoverDirect)
        XCTAssertEqual(settings.tor.proxyType, 1)
        XCTAssertEqual(settings.tor.trrMode, 5)
        XCTAssertTrue(AnonymityGuard.assess(settings).isEmpty)
    }

    func testRoundTripAndGarbageFallsBackToDefaults() throws {
        let store = MemoryKeyValueStore()
        let settingsStore = SettingsStore(store: store)
        var settings = VeilSettings.veilDefault
        settings.wipeOnClose = false
        settings.tor.bridgeLines = ["obfs4 1.2.3.4:443 cert"]
        settings.tor.useBridges = true
        settingsStore.save(settings)
        let loaded = SettingsStore(store: store).load()
        XCTAssertEqual(loaded, settings)
        store.set(Data("nope".utf8), forKey: SettingsStore.storageKey)
        XCTAssertEqual(SettingsStore(store: store).load(), .veilDefault)
    }

    func testTurningOffHTTPSOnlyBlocksBrowsing() {
        var settings = VeilSettings.veilDefault
        settings.httpsOnly = false
        let problems = AnonymityGuard.assess(settings)
        XCTAssertTrue(problems.contains { $0.pref == "veil.https_only" })
        let gate = TrafficGate.evaluate(settings: settings, torState: .connected, endpoint: TorEndpoint(host: "127.0.0.1", port: 9150))
        guard case .blocked = gate else { return XCTFail("expected the guard to stop browsing") }
    }

    @MainActor
    func testBookmarksHistoryAndWipe() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("veil-test-\(UUID().uuidString)/VEIL", isDirectory: true)
        let persistence = FileSessionPersistence(directory: directory)
        let sessions = SessionStore(persistence: persistence, persists: true)
        let url = URL(string: "https://example.com/a")!
        sessions.addBookmark(title: "Example", url: url)
        sessions.addBookmark(title: "Example again", url: url)
        XCTAssertEqual(sessions.bookmarks.count, 1)
        XCTAssertEqual(sessions.bookmarks.first?.title, "Example again")
        for index in 0..<SessionStore.historyCap + 5 {
            sessions.recordVisit(title: "Page \(index)", url: URL(string: "https://example.com/\(index)")!)
        }
        XCTAssertEqual(sessions.history.count, SessionStore.historyCap)
        XCTAssertEqual(sessions.history.first?.title, "Page \(SessionStore.historyCap + 4)")
        XCTAssertEqual(sessions.startPageBookmarks.count, 1)
        let reloaded = SessionStore(persistence: FileSessionPersistence(directory: directory), persists: true)
        XCTAssertEqual(reloaded.bookmarks.map(\.url), [url])
        reloaded.setPersists(false)
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
        XCTAssertFalse(SessionPaths.isWipeable(URL(fileURLWithPath: "/")))
        XCTAssertFalse(SessionPaths.isWipeable(URL(fileURLWithPath: "/tmp")))
        DownloadDirectory.wipe(URL(fileURLWithPath: "/"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: "/"))
    }

    func testDownloadNamesStayInsideTheDownloadsFolder() {
        XCTAssertEqual(DownloadDirectory.sanitize("../etc/passwd"), "passwd")
        XCTAssertEqual(DownloadDirectory.sanitize("my report.pdf"), "my report.pdf")
        XCTAssertEqual(DownloadDirectory.sanitize(".."), "download")
        XCTAssertEqual(DownloadDirectory.sanitize(""), "download")
        let directory = URL(fileURLWithPath: "/tmp/VEILDownloads", isDirectory: true)
        let first = DownloadDirectory.uniqueDestination(directory: directory, suggested: "a/../../report.pdf", exists: { _ in false })
        XCTAssertEqual(first.lastPathComponent, "report.pdf")
        XCTAssertEqual(first.deletingLastPathComponent().lastPathComponent, "VEILDownloads")
        let second = DownloadDirectory.uniqueDestination(directory: directory, suggested: "report.pdf", exists: { $0.lastPathComponent == "report.pdf" })
        XCTAssertEqual(second.lastPathComponent, "report-2.pdf")
    }
}
