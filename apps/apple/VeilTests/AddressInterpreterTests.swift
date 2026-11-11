import XCTest
@testable import Veil

final class AddressInterpreterTests: XCTestCase {
    func testCommandSpellingsAndPromptTidying() {
        XCTAssertEqual(AppCommands.parse("@scalvs hi")?.id, "scalvs")
        XCTAssertEqual(AppCommands.parse("@Scalus hi")?.id, "scalvs")
        XCTAssertEqual(AppCommands.parse("@CNDCTR go")?.id, "cndctr")
        XCTAssertEqual(AppCommands.parse("@conductor go")?.id, "cndctr")
        XCTAssertEqual(AppCommands.parse("  @scalvs   summarize\n this   page "), AppCommands.Command(id: "scalvs", prompt: "summarize this page"))
        XCTAssertEqual(AppCommands.parse("@scalvs"), AppCommands.Command(id: "scalvs", prompt: ""))
    }

    func testOrdinaryInputIsNotACommand() {
        for input in ["scalvs hi", "@scalvsx hi", "email@scalvs.com", "@", "@unknown hi", "https://scalvs.ai", "what is @scalvs", ""] {
            XCTAssertNil(AppCommands.parse(input), input)
        }
    }

    func testPromptsAreCapped() {
        let prompt = AppCommands.parse("@scalvs " + String(repeating: "x", count: AppCommands.maxPrompt + 50))?.prompt
        XCTAssertEqual(prompt?.count, AppCommands.maxPrompt)
    }

    func testSuggestionNeverSearchesOrRecordsHistory() throws {
        let (registry, _) = try fixtureRegistry()
        let suggestion = AppCommands.suggestion(for: "@scalvs summarize this page", registry: registry)
        XCTAssertEqual(suggestion?.label, "Ask SCALVS.ai™: summarize this page")
        XCTAssertEqual(suggestion?.sendToSearchEngine, false)
        XCTAssertEqual(suggestion?.recordInHistory, false)
        XCTAssertEqual(AppCommands.suggestion(for: "@cndctr export reports", registry: registry)?.label, "Run in /CNDCTR/™: export reports")
        XCTAssertEqual(AppCommands.suggestion(for: "@cndctr", registry: registry)?.label, "Open /CNDCTR/™")
        XCTAssertNil(AppCommands.suggestion(for: "@scalvs hi", registry: AppRegistry.empty))
    }

    func testPromptRidesInTheFragment() {
        let url = URL(string: AppCommands.panelURL(base: "https://apps.example/scalus?x=1", prompt: "a&b #c"))!
        XCTAssertEqual(url.query, "x=1")
        let fragment = String(url.fragment?.dropFirst("prompt=".count) ?? "")
        XCTAssertEqual(fragment.removingPercentEncoding, "a&b #c")
        XCTAssertEqual(AppCommands.panelURL(base: "https://apps.example/scalus#old", prompt: ""), "https://apps.example/scalus")
    }

    func testCommandOutcomeIsNotASearch() throws {
        let (registry, _) = try fixtureRegistry()
        let outcome = AddressInterpreter.decide("@scalvs summarize", registry: registry, settings: .veilDefault)
        guard case .command(let command) = outcome else { return XCTFail("expected a command") }
        XCTAssertEqual(command.id, "scalvs")
        XCTAssertFalse(outcome.recordsHistory)
        XCTAssertFalse(outcome.sendsToSearchEngine)
        let rows = AddressSuggestions.rows(for: "@scalvs summarize", registry: registry, settings: .veilDefault)
        XCTAssertEqual(rows.count, 1)
        XCTAssertFalse(rows.contains { if case .search = $0.kind { return true }; return false })
    }

    func testAddressesSearchAndBlockedSchemes() throws {
        let (registry, _) = try fixtureRegistry()
        let settings = VeilSettings.veilDefault
        guard case .navigate(let https) = AddressInterpreter.decide("example.com", registry: registry, settings: settings) else {
            return XCTFail("host")
        }
        XCTAssertEqual(https.absoluteString, "https://example.com")
        guard case .navigate(let upgraded) = AddressInterpreter.decide("http://example.com/a", registry: registry, settings: settings) else {
            return XCTFail("upgrade")
        }
        XCTAssertEqual(upgraded.scheme, "https")
        guard case .navigate(let onion) = AddressInterpreter.decide("http://example.onion/path", registry: registry, settings: settings) else {
            return XCTFail("onion")
        }
        XCTAssertEqual(onion.absoluteString, "http://example.onion/path")
        guard case .search(let search) = AddressInterpreter.decide("private search", registry: registry, settings: settings) else {
            return XCTFail("search")
        }
        XCTAssertEqual(search.host, "duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion")
        XCTAssertNotEqual(search.host, "duckduckgo.com")
        XCTAssertEqual(URLComponents(url: search, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "private search")
        for input in ["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "blob:https://example.com/id"] {
            guard case .search = AddressInterpreter.decide(input, registry: registry, settings: settings) else {
                return XCTFail("\(input) must not navigate")
            }
        }
    }

    func testLocalAddressesAreBlockedAndNotSearched() throws {
        let (registry, _) = try fixtureRegistry()
        for input in ["127.0.0.1", "http://localhost/", "https://192.168.1.5/admin", "http://[::1]/", "10.1.2.3", "http://169.254.1.1/", "printer.local"] {
            guard case .blocked = AddressInterpreter.decide(input, registry: registry, settings: .veilDefault) else {
                return XCTFail(input)
            }
            let rows = AddressSuggestions.rows(for: input, registry: registry, settings: .veilDefault)
            XCTAssertFalse(rows.contains { if case .search = $0.kind { return true }; return false }, input)
        }
        XCTAssertFalse(HostPolicy.isNonGlobal("8.8.8.8"))
        XCTAssertFalse(HostPolicy.isNonGlobal("example.com"))
        XCTAssertTrue(HostPolicy.isNonGlobal("0177.0.0.1"))
    }

    func testRegistrySortAndHttpsOnly() throws {
        let names = ["+SPCTR™", "ÆTHER™", "/CNDCTR/™", "E(O)N™"]
        XCTAssertEqual(names.sorted { AppRegistry.sortKey($0) < AppRegistry.sortKey($1) }, ["ÆTHER™", "/CNDCTR/™", "E(O)N™", "+SPCTR™"])
        let data = try JSONSerialization.data(withJSONObject: [
            "signin": ["label": "Sign In", "url": "http://id.example/"],
            "apps": [
                ["id": "bad", "name": "Bad", "summary": "no", "url": "http://bad.example/"],
                ["id": "ok", "name": "Ok", "summary": "yes", "url": "https://ok.example/a"],
                ["id": "user", "name": "User", "summary": "no", "url": "https://user:pass@ok.example/"],
            ],
        ])
        let registry = try AppRegistry.load(data: data)
        XCTAssertNil(registry.signIn)
        XCTAssertEqual(registry.apps.map(\.id), ["ok"])
    }

    func testShippedRegistryMatchesTheBrowserList() throws {
        let shipped = try Data(contentsOf: RepoPaths.root.appendingPathComponent("veil-chrome/registry/registry.json"))
        let bundled = try Data(contentsOf: RepoPaths.apple.appendingPathComponent("Veil/Resources/registry.json"))
        let left = try JSONSerialization.jsonObject(with: shipped) as! NSDictionary
        let right = try JSONSerialization.jsonObject(with: bundled) as! NSDictionary
        XCTAssertEqual(left, right)
        let registry = try AppRegistry.load(data: bundled)
        XCTAssertEqual(registry.apps.map(\.id), ["cndctr", "cumulus", "mail", "fabric", "firm", "metatron", "scalvs"])
        XCTAssertEqual(registry.apps.filter(\.panel).map(\.id), ["cndctr", "scalvs"])
        XCTAssertEqual(registry.apps.filter(\.footer).map(\.id), ["fabric"])
        XCTAssertEqual(registry.signIn?.label, "Sign In")
        let raw = try JSONSerialization.jsonObject(with: bundled) as! [String: Any]
        XCTAssertNil(try CumulusConfigReader.read(raw))
    }

    func testStartPageCopyAndColorsMatchTheBrowser() throws {
        let html = try String(contentsOf: RepoPaths.root.appendingPathComponent("veil-chrome/src/home/home.html"), encoding: .utf8)
        let script = try String(contentsOf: RepoPaths.root.appendingPathComponent("veil-chrome/src/home/home.js"), encoding: .utf8)
        let shell = try String(contentsOf: RepoPaths.root.appendingPathComponent("veil-prototype/static/index.html"), encoding: .utf8)
        XCTAssertTrue(html.contains("VEIL&lt;/&gt;"))
        XCTAssertTrue(html.contains(VeilCopy.searchPlaceholder))
        XCTAssertTrue(html.contains(VeilCopy.workspace))
        XCTAssertTrue(html.contains(VeilCopy.signIn))
        XCTAssertTrue(html.contains(VeilCopy.newCircuit))
        XCTAssertTrue(html.contains(VeilCopy.newIdentity))
        XCTAssertTrue(html.contains("Blockchain-governed&#8482;."))
        XCTAssertTrue(html.contains("&#169; 2026 Infinitum Corporation"))
        XCTAssertTrue(html.contains(VeilCopy.statusChecking))
        for text in [VeilCopy.statusConnected, VeilCopy.statusConnecting, VeilCopy.statusError, VeilCopy.statusBlocked] {
            XCTAssertTrue(script.contains(text), text)
        }
        XCTAssertTrue(shell.contains(VeilCopy.addressPlaceholder))
        let css = try String(contentsOf: RepoPaths.root.appendingPathComponent("veil-chrome/src/shared/veil.css"), encoding: .utf8)
        let shellCSS = try String(contentsOf: RepoPaths.root.appendingPathComponent("veil-prototype/static/shell.css"), encoding: .utf8)
        let theme = try String(contentsOf: RepoPaths.apple.appendingPathComponent("Veil/VeilTheme.swift"), encoding: .utf8)
        for hex in ["111820", "6b6b74", "e8e8ec", "f3f3f5", "1f5fd6", "5b3fd1", "49545e", "1f9d55", "d29a00", "d1342f"] {
            XCTAssertTrue(css.lowercased().contains("#\(hex)"), hex)
            XCTAssertTrue(theme.lowercased().contains("0x\(hex)"), hex)
        }
        for hex in ["eef0f3", "5f6670", "e3e4e8", "e2e5e9", "b4b8bf"] {
            XCTAssertTrue(shellCSS.lowercased().contains("#\(hex)"), hex)
            XCTAssertTrue(theme.lowercased().contains("0x\(hex)"), hex)
        }
        XCTAssertTrue(css.contains("Helvetica Neue"))
        XCTAssertTrue(shellCSS.contains("Helvetica Neue"))
        XCTAssertTrue(theme.contains("Helvetica Neue"))
    }

    func testAppleTreeDoesNotUseTheRetiredDomainOrADirectSession() throws {
        let forbidden = [
            ["infinitumcorporation", ".", "ai"].joined(),
            ["URLSession", ".", "shared"].joined(),
            ["connectionProxy", "Dictionary"].joined(),
        ]
        let root = RepoPaths.apple
        let files = try FileManager.default.subpathsOfDirectory(atPath: root.path)
        for relative in files where relative.hasSuffix(".swift") || relative.hasSuffix(".md") || relative.hasSuffix(".plist") || relative.hasSuffix(".json") || relative.hasSuffix(".yml") {
            let text = try String(contentsOf: root.appendingPathComponent(relative), encoding: .utf8)
            for needle in forbidden {
                XCTAssertFalse(text.contains(needle), "\(relative) contains \(needle)")
            }
        }
    }

    @MainActor
    func testSubmittingACommandDoesNotRecordHistory() throws {
        let (registry, json) = try fixtureRegistry()
        let model = makeModel(registry: registry, json: json)
        model.addressText = "@scalvs summarize this page"
        model.submitAddress()
        XCTAssertTrue(model.history.isEmpty)
        XCTAssertEqual(model.panel?.appID, "scalvs")
        XCTAssertEqual(model.panel?.url.fragment?.removingPercentEncoding, "prompt=summarize this page")
        XCTAssertNil(model.panel?.url.query)
        model.openURL(URL(string: "https://example.com/")!, newTab: false)
        XCTAssertTrue(model.history.isEmpty)
        XCTAssertFalse(model.selected.showsStartPage)
        XCTAssertFalse(model.gate.allowsLoads)
        model.openURL(URL(string: "http://127.0.0.1/")!, newTab: false)
        XCTAssertEqual(model.selected.url?.host, "example.com")
    }
}

@MainActor
func makeModel(registry: AppRegistry, json: [String: Any]) -> BrowserModel {
    BrowserModel(
        registry: registry,
        registryJSON: json,
        settingsStore: SettingsStore(store: MemoryKeyValueStore()),
        sessions: SessionStore(persistence: MemorySessionPersistence(), persists: false),
        tor: EmbeddedTorClient(configuration: .veilDefault, locator: .missing),
        fetcher: RefusingFetcher()
    )
}
