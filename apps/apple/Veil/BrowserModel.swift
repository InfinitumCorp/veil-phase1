import Combine
import Foundation
import Network
import WebKit

enum BrowserSheet: String, Identifiable {
    case settings
    case library
    case about
    var id: String { rawValue }
}

enum LibraryTab: String, CaseIterable, Identifiable {
    case bookmarks
    case history
    case downloads
    var id: String { rawValue }
    var title: String {
        switch self {
        case .bookmarks: return "Bookmarks"
        case .history: return "History"
        case .downloads: return "Downloads"
        }
    }
}

struct BrowserTab: Identifiable, Equatable {
    var id: UUID
    var title: String
    var url: URL?
    var showsStartPage: Bool
    var canGoBack: Bool
    var canGoForward: Bool
    var isLoading: Bool
    var loadGeneration: Int

    static func start() -> BrowserTab {
        BrowserTab(
            id: UUID(),
            title: VeilCopy.newTab,
            url: nil,
            showsStartPage: true,
            canGoBack: false,
            canGoForward: false,
            isLoading: false,
            loadGeneration: 0
        )
    }
}

struct PanelState: Equatable {
    var appID: String
    var title: String
    var url: URL
    var generation: Int
}

struct DownloadItem: Identifiable, Equatable {
    enum State: Equatable {
        case running
        case finished
        case failed(String)
    }

    var id: UUID
    var filename: String
    var path: URL
    var state: State
}

struct TabOrder: Equatable {
    enum Action: Equatable {
        case back
        case forward
        case reload
        case stop
    }

    var id: UUID
    var action: Action
    var token: Int
}

enum WebNavigation: Equatable {
    case allow
    case cancel
    case redirect(URL)
}

private final class GateSource {
    var current: @MainActor () -> TrafficGate = { .paused(VeilCopy.statusError) }
}

@MainActor
final class BrowserModel: ObservableObject {
    @Published var tabs: [BrowserTab]
    @Published var selectedTabID: UUID
    @Published var addressText = ""
    @Published var addressEditing = false
    @Published var suggestions: [AddressSuggestion] = []
    @Published var suggestionIndex = 0
    @Published var menuOpen = false
    @Published var appsMenuOpen = false
    @Published var sheet: BrowserSheet?
    @Published var libraryTab: LibraryTab = .bookmarks
    @Published var panel: PanelState?
    @Published var panelWidth: CGFloat = 420
    @Published var toast: String?
    @Published var torState: TorConnectionState = .unknown
    @Published var statusText: String = VeilCopy.statusChecking
    @Published var bookmarks: [Bookmark] = []
    @Published var history: [HistoryEntry] = []
    @Published var downloads: [DownloadItem] = []
    @Published var settings: VeilSettings
    @Published var accountName: String?
    @Published var rulesCompiled = false
    @Published var rulesDiagnostic = ""
    @Published var sessionGeneration = 0
    @Published var tabOrder: TabOrder?
    @Published var addressFocusToken = 0

    let registry: AppRegistry
    let tor: EmbeddedTorClient
    private let settingsStore: SettingsStore
    private let sessions: SessionStore
    private let cumulus: CumulusSession
    private let gateSource: GateSource
    private var dataStore: WKWebsiteDataStore?
    private var contentRules: WKContentRuleList?
    private var cancellables: Set<AnyCancellable> = []
    private var lastRecorded: [UUID: URL] = [:]
    private var sawAllowedTraffic = false

    init(
        registry: AppRegistry,
        registryJSON: [String: Any],
        settingsStore: SettingsStore,
        sessions: SessionStore,
        tor: EmbeddedTorClient,
        fetcher: (any FormPosting)? = nil
    ) {
        let source = GateSource()
        let poster = fetcher ?? ProxiedFormPoster { source.current() }
        let first = BrowserTab.start()
        self.registry = registry
        self.tor = tor
        self.settingsStore = settingsStore
        self.sessions = sessions
        self.settings = settingsStore.load()
        self.cumulus = CumulusSession(registryJSON: registryJSON, fetcher: poster)
        self.gateSource = source
        tabs = [first]
        selectedTabID = first.id
        bookmarks = sessions.bookmarks
        history = sessions.history
        source.current = { [weak self] in
            self?.gate ?? .paused(VeilCopy.statusError)
        }
        tor.$state.receive(on: DispatchQueue.main).sink { [weak self] _ in
            Task { @MainActor in self?.refreshStatus() }
        }.store(in: &cancellables)
        tor.$diagnostics.receive(on: DispatchQueue.main).sink { [weak self] _ in
            Task { @MainActor in self?.objectWillChange.send() }
        }.store(in: &cancellables)
    }

    static func live() -> BrowserModel {
        let settingsStore = SettingsStore(
            store: UserDefaultsStore(defaults: UserDefaults(suiteName: "app.infinitumveil.browser") ?? .standard)
        )
        let settings = settingsStore.load()
        let directory = veilSupportDirectory()
        let sessions = SessionStore(
            persistence: FileSessionPersistence(directory: directory),
            persists: !settings.wipeOnClose
        )
        if settings.wipeOnClose {
            DownloadDirectory.wipe(DownloadDirectory.directory())
        }
        let json = bundledRegistryJSON()
        let registry = (try? AppRegistry.load(data: json)) ?? AppRegistry.loadBundled()
        let parsed = try? JSONSerialization.jsonObject(with: json)
        let object = parsed as? [String: Any] ?? [:]
        return BrowserModel(
            registry: registry,
            registryJSON: object,
            settingsStore: settingsStore,
            sessions: sessions,
            tor: EmbeddedTorClient.bundled(configuration: settings.tor)
        )
    }

    var selected: BrowserTab {
        if let tab = tabs.first(where: { $0.id == selectedTabID }) { return tab }
        return tabs.first ?? BrowserTab.start()
    }

    var gate: TrafficGate {
        TrafficGate.evaluate(settings: settings, torState: tor.state, endpoint: tor.socksEndpoint)
    }

    var chipText: String { accountName == nil ? VeilCopy.chipAnonymous : VeilCopy.chipSignedIn }

    var workspaceText: String { accountName == nil ? VeilCopy.workspace : VeilCopy.workspaceSignedIn }

    var anonymityProblems: [AnonymityProblem] { AnonymityGuard.assess(settings) }

    var systemProxy: SystemProxyPlan {
        SystemProxyPlan.notApplied(host: settings.tor.socksHost, port: settings.tor.socksPort)
    }

    var packetTunnel: PacketTunnelPlan {
        PacketTunnelPlan.unavailable(socks: settings.tor.socksEndpoint)
    }

    func start() async {
        async let compiled: Void = compileRules()
        await tor.start()
        refreshStatus()
        await compiled
    }

    func refreshStatus() {
        let problems = AnonymityGuard.assess(settings)
        if problems.isEmpty {
            torState = tor.state
        } else {
            torState = .blocked
        }
        statusText = TorStatusText.text(torState: tor.state, problems: problems)
        let allowed = gate.allowsLoads
        if allowed != sawAllowedTraffic {
            sawAllowedTraffic = allowed
            dataStore = nil
            sessionGeneration += 1
        }
    }

    func submitAddress() {
        let text = addressText.trimmingCharacters(in: .whitespacesAndNewlines)
        addressEditing = false
        if case .command(let command) = AddressInterpreter.decide(text, registry: registry, settings: settings) {
            openCommand(command)
            return
        }
        if !suggestions.isEmpty {
            let index = min(max(suggestionIndex, 0), suggestions.count - 1)
            apply(suggestions[index])
            return
        }
        apply(AddressInterpreter.decide(text, registry: registry, settings: settings))
    }

    func addressChanged() {
        suggestions = AddressSuggestions.rows(for: addressText, registry: registry, settings: settings)
        suggestionIndex = 0
    }

    func moveSuggestion(_ delta: Int) {
        guard !suggestions.isEmpty else { return }
        suggestionIndex = (suggestionIndex + delta + suggestions.count) % suggestions.count
    }

    func apply(_ suggestion: AddressSuggestion) {
        switch suggestion.kind {
        case .command(let command):
            openCommand(command)
        case .complete(let text):
            addressText = text
            addressEditing = true
            addressChanged()
        case .open(let url), .search(let url):
            suggestions = []
            openURL(url, newTab: false)
        case .blocked(let reason):
            suggestions = []
            toast = reason
        }
    }

    func apply(_ outcome: AddressOutcome) {
        switch outcome {
        case .empty:
            break
        case .command(let command):
            openCommand(command)
        case .navigate(let url), .search(let url):
            suggestions = []
            openURL(url, newTab: false)
        case .blocked(let reason):
            suggestions = []
            toast = reason
        }
    }

    func openCommand(_ command: AppCommands.Command) {
        guard let app = registry.app(id: command.id) else {
            toast = "That app is not in this build."
            suggestions = []
            return
        }
        guard let url = URL(string: AppCommands.panelURL(base: app.url.absoluteString, prompt: command.prompt)) else { return }
        if panel?.appID == app.id {
            panel?.url = url
            panel?.generation += 1
        } else {
            panel = PanelState(appID: app.id, title: app.name, url: url, generation: 1)
        }
        addressText = ""
        suggestions = []
        menuOpen = false
        appsMenuOpen = false
    }

    func togglePanel(appID: String) {
        if panel?.appID == appID {
            panel = nil
            return
        }
        guard let app = registry.app(id: appID) else { return }
        openCommand(AppCommands.Command(id: app.id, prompt: ""))
    }

    func openURL(_ url: URL, newTab: Bool) {
        switch NavigationPolicy.classify(url, settings: settings) {
        case .block(let reason):
            toast = reason
        case .allow(let allowed):
            if newTab { self.newTab() }
            updateSelected { tab in
                tab.showsStartPage = false
                tab.url = allowed
                tab.title = allowed.host ?? allowed.absoluteString
                tab.loadGeneration += 1
            }
            addressText = allowed.absoluteString
            suggestions = []
        }
    }

    func decideNavigation(_ url: URL) -> WebNavigation {
        if cumulus.isRedirect(url) {
            Task { await finishSignIn(url) }
            return .cancel
        }
        switch NavigationPolicy.classify(url, settings: settings) {
        case .block:
            return .cancel
        case .allow(let allowed):
            if allowed.absoluteString != url.absoluteString {
                return .redirect(allowed)
            }
            guard gate.allowsLoads else { return .cancel }
            return .allow
        }
    }

    func newTab() {
        let tab = BrowserTab.start()
        tabs.append(tab)
        selectedTabID = tab.id
        addressText = ""
        suggestions = []
        addressFocusToken += 1
    }

    func closeTab(_ id: UUID) {
        guard let index = tabs.firstIndex(where: { $0.id == id }) else { return }
        tabs.remove(at: index)
        if tabs.isEmpty {
            let tab = BrowserTab.start()
            tabs = [tab]
            selectedTabID = tab.id
        } else if selectedTabID == id {
            selectedTabID = tabs[min(index, tabs.count - 1)].id
        }
        syncAddressToSelected()
    }

    func selectTab(_ id: UUID) {
        selectedTabID = id
        syncAddressToSelected()
    }

    func goBack() { order(.back) }
    func goForward() { order(.forward) }
    func reload() {
        guard gate.allowsLoads, !selected.showsStartPage else {
            toast = statusText
            return
        }
        order(.reload)
    }

    func toggleBookmark() {
        guard let url = selected.url, !selected.showsStartPage else { return }
        if bookmarks.contains(where: { $0.url == url }) {
            sessions.removeBookmark(url: url)
        } else {
            sessions.addBookmark(title: selected.title, url: url)
        }
        bookmarks = sessions.bookmarks
    }

    func removeBookmark(_ url: URL) {
        sessions.removeBookmark(url: url)
        bookmarks = sessions.bookmarks
    }

    func clearHistory() {
        sessions.clearHistory()
        history = []
        lastRecorded = [:]
    }

    func signIn() {
        appsMenuOpen = false
        if cumulus.enabled {
            do {
                openURL(try cumulus.authorizeURL(), newTab: true)
            } catch {
                toast = "Cumulus://ID is not available."
            }
            return
        }
        guard let link = registry.signIn else { return }
        openURL(link.url, newTab: true)
    }

    func openMail() {
        guard let mail = registry.mail else { return }
        openURL(mail.url, newTab: true)
    }

    func openApp(_ app: RegistryApp) {
        appsMenuOpen = false
        if app.panel {
            togglePanel(appID: app.id)
        } else {
            openURL(app.url, newTab: true)
        }
    }

    func newIdentity() {
        cumulus.forget()
        accountName = nil
        panel = nil
        sessions.clearHistory()
        history = []
        lastRecorded = [:]
        let tab = BrowserTab.start()
        tabs = [tab]
        selectedTabID = tab.id
        addressText = ""
        suggestions = []
        menuOpen = false
        appsMenuOpen = false
        dataStore = nil
        sessionGeneration += 1
        toast = "New identity: tabs closed, panel closed, signed out."
        Task { await tor.newIdentity() }
    }

    func newCircuit() {
        let host = selected.url?.host ?? ""
        Task {
            await tor.newCircuit(forHost: host)
            toast = tor.diagnostics
        }
    }

    func closeMenus() {
        menuOpen = false
        appsMenuOpen = false
        suggestions = []
    }

    func updateSettings(_ body: (inout VeilSettings) -> Void) {
        let wasWiping = settings.wipeOnClose
        body(&settings)
        settingsStore.save(settings)
        if settings.wipeOnClose != wasWiping {
            sessions.setPersists(!settings.wipeOnClose)
            if settings.wipeOnClose {
                DownloadDirectory.wipe(DownloadDirectory.directory())
                downloads = []
            }
        } else if !settings.wipeOnClose {
            sessions.setPersists(true)
        }
        refreshStatus()
    }

    func webConfiguration() -> WKWebViewConfiguration {
        WebKitFactory.configuration(store: ensureDataStore(), rules: contentRules, plan: .veil)
    }

    func notePage(_ tabID: UUID, title: String?, url: URL?, back: Bool, forward: Bool, loading: Bool) {
        guard let index = tabs.firstIndex(where: { $0.id == tabID }) else { return }
        if let title, !title.isEmpty { tabs[index].title = title }
        else if let host = url?.host { tabs[index].title = host }
        tabs[index].url = url ?? tabs[index].url
        tabs[index].canGoBack = back
        tabs[index].canGoForward = forward
        tabs[index].isLoading = loading
        if tabID == selectedTabID, !addressEditing, let url {
            addressText = url.absoluteString
        }
        if !loading, let url, lastRecorded[tabID] != url, shouldRemember(url) {
            lastRecorded[tabID] = url
            sessions.recordVisit(title: tabs[index].title, url: url)
            history = sessions.history
        }
    }

    func addDownload(_ item: DownloadItem) {
        downloads.insert(item, at: 0)
    }

    func updateDownload(_ id: UUID, state: DownloadItem.State) {
        guard let index = downloads.firstIndex(where: { $0.id == id }) else { return }
        downloads[index].state = state
    }

    func wipeIfNeeded() {
        guard settings.wipeOnClose else { return }
        sessions.setPersists(false)
        bookmarks = []
        history = []
        downloads = []
        DownloadDirectory.wipe(DownloadDirectory.directory())
        dataStore = nil
    }

    func discardDiskIfWiping() {
        guard settings.wipeOnClose else { return }
        sessions.setPersists(false)
        DownloadDirectory.wipe(DownloadDirectory.directory())
    }

    private func finishSignIn(_ url: URL) async {
        do {
            let account = try await cumulus.handleRedirect(url, gate: gate)
            accountName = account.name.isEmpty ? VeilCopy.chipSignedIn : account.name
            toast = accountName
        } catch let error as CumulusSignInError {
            if case .message(let text) = error { toast = text }
            cumulus.forget()
            accountName = nil
        } catch {
            toast = "Sign-in did not finish."
            cumulus.forget()
            accountName = nil
        }
    }

    private func shouldRemember(_ url: URL) -> Bool {
        let scheme = url.scheme?.lowercased()
        if scheme == "about" { return false }
        return scheme == "https" || url.host?.lowercased().hasSuffix(".onion") == true
    }

    private func order(_ action: TabOrder.Action) {
        tabOrder = TabOrder(id: selectedTabID, action: action, token: (tabOrder?.token ?? 0) + 1)
    }

    private func updateSelected(_ body: (inout BrowserTab) -> Void) {
        guard let index = tabs.firstIndex(where: { $0.id == selectedTabID }) else { return }
        body(&tabs[index])
    }

    private func syncAddressToSelected() {
        addressEditing = false
        suggestions = []
        addressText = selected.showsStartPage ? "" : (selected.url?.absoluteString ?? "")
    }

    private func ensureDataStore() -> WKWebsiteDataStore {
        if let dataStore { return dataStore }
        let store = WKWebsiteDataStore.nonPersistent()
        if case .allowed(let endpoint) = gate {
            WebKitFactory.apply(proxy: WebKitProxyPlan.make(endpoint: endpoint, settings: settings), to: store)
        }
        dataStore = store
        return store
    }

    private func compileRules() async {
        guard let json = try? ContentRules.jsonString(), let store = WKContentRuleListStore.default() else {
            rulesDiagnostic = "Content rules could not be prepared."
            return
        }
        let list: WKContentRuleList? = await withCheckedContinuation { continuation in
            store.compileContentRuleList(forIdentifier: ContentRules.identifier, encodedContentRuleList: json) { rules, _ in
                continuation.resume(returning: rules)
            }
        }
        contentRules = list
        rulesCompiled = list != nil
        rulesDiagnostic = list == nil ? "Content rules did not compile." : ""
        if list != nil {
            dataStore = nil
        }
    }
}

private func veilSupportDirectory() -> URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        ?? FileManager.default.temporaryDirectory
    return base.appendingPathComponent("VEIL", isDirectory: true)
}

private func bundledRegistryJSON() -> Data {
    let bundles = [Bundle.main] + Bundle.allBundles
    for bundle in bundles {
        if let url = bundle.url(forResource: "registry", withExtension: "json"),
           let data = try? Data(contentsOf: url) {
            return data
        }
    }
    return Data("{}".utf8)
}

enum WebKitFactory {
    static func apply(proxy: WebKitProxyPlan, to store: WKWebsiteDataStore) {
        guard proxy.version == 5, AnonymityGuard.isLoopback(proxy.host), let port = NWEndpoint.Port(rawValue: proxy.port) else {
            return
        }
        var configuration = ProxyConfiguration(socksv5Proxy: NWEndpoint.hostPort(host: NWEndpoint.Host(proxy.host), port: port))
        configuration.allowFailover = false
        configuration.excludedDomains = []
        store.proxyConfigurations = [configuration]
    }

    static func configuration(store: WKWebsiteDataStore, rules: WKContentRuleList?, plan: WebPrivacyPlan) -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = store
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = plan.javascriptCanOpenWindowsAutomatically
        configuration.preferences.isFraudulentWebsiteWarningEnabled = plan.fraudulentWebsiteWarning
        configuration.preferences.isSiteSpecificQuirksModeEnabled = plan.siteSpecificQuirks
        configuration.preferences.isElementFullscreenEnabled = plan.elementFullscreen
        configuration.mediaTypesRequiringUserActionForPlayback = plan.mediaPlaybackRequiresUserAction ? .all : []
        let script = WKUserScript(source: plan.referrerScript, injectionTime: .atDocumentStart, forMainFrameOnly: false)
        configuration.userContentController.addUserScript(script)
        if let rules {
            configuration.userContentController.add(rules)
        }
        return configuration
    }
}
