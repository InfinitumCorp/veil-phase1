import Foundation

/// Address-bar commands. The words, the 2000-character cap, and the fragment
/// rule match `veil-browser/src/VeilAppCommands.sys.mjs`.
enum AppCommands {
    static let maxPrompt = 2000
    static let ordered: [(id: String, words: [String])] = [
        ("scalvs", ["scalvs", "scalus"]),
        ("cndctr", ["cndctr", "conductor"]),
    ]
    static let verbs = ["scalvs": "Ask", "cndctr": "Run in"]

    struct Command: Equatable {
        var id: String
        var prompt: String
    }

    static func parse(_ input: String) -> Command? {
        guard let commandExpression,
              let match = commandExpression.firstMatch(in: input, range: NSRange(input.startIndex..., in: input)) else {
            return nil
        }
        guard let wordRange = Range(match.range(at: 1), in: input) else { return nil }
        let word = input[wordRange].lowercased()
        guard let id = ordered.first(where: { $0.words.contains(word) })?.id else { return nil }
        var prompt = ""
        if match.range(at: 2).location != NSNotFound, let promptRange = Range(match.range(at: 2), in: input) {
            prompt = input[promptRange].replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            prompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if prompt.count > maxPrompt {
            prompt = String(prompt.prefix(maxPrompt))
        }
        return Command(id: id, prompt: prompt)
    }

    struct Suggestion: Equatable {
        var id: String
        var prompt: String
        var label: String
        var recordInHistory = false
        var sendToSearchEngine = false
    }

    static func suggestion(for input: String, registry: AppRegistry) -> Suggestion? {
        guard let command = parse(input), let app = registry.app(id: command.id) else { return nil }
        let verb = verbs[command.id] ?? "Open"
        let label = command.prompt.isEmpty ? "Open \(app.name)" : "\(verb) \(app.name): \(command.prompt)"
        return Suggestion(id: command.id, prompt: command.prompt, label: label)
    }

    /// The prompt rides in the URL fragment, which is not sent to the server.
    static func panelURL(base: String, prompt: String) -> String {
        let baseWithoutHash = base.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? base
        guard !prompt.isEmpty else { return baseWithoutHash }
        return baseWithoutHash + "#prompt=" + encodeURIComponent(prompt)
    }

    static func encodeURIComponent(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-_.!~*'()")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    private static let commandExpression: NSRegularExpression? = try? NSRegularExpression(
        pattern: #"^\s*@([A-Za-z]+)(?:\s+([\s\S]*))?$"#
    )
}

enum AddressOutcome: Equatable {
    case empty
    case command(AppCommands.Command)
    case navigate(URL)
    case search(URL)
    case blocked(String)

    var recordsHistory: Bool {
        switch self {
        case .navigate, .search: return true
        case .empty, .command, .blocked: return false
        }
    }

    var sendsToSearchEngine: Bool {
        if case .search = self { return true }
        return false
    }
}

enum NavigationVerdict: Equatable {
    case allow(URL)
    case block(String)
}

/// What may be loaded in a tab. Private and local addresses are refused so a
/// page cannot ask WebKit to connect to the device itself.
enum NavigationPolicy {
    static let localRefusal = "That address stays on the local network, so VEIL will not open it."
    static let schemeRefusal = "VEIL only opens https pages."

    static func classify(_ url: URL, settings: VeilSettings) -> NavigationVerdict {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return .block(schemeRefusal)
        }
        let scheme = (components.scheme ?? "").lowercased()
        if scheme == "about" {
            return .allow(url)
        }
        guard scheme == "http" || scheme == "https" else {
            return .block(schemeRefusal)
        }
        if components.user != nil || components.password != nil {
            return .block(schemeRefusal)
        }
        guard let host = components.host?.lowercased(), !host.isEmpty else {
            return .block(schemeRefusal)
        }
        if HostPolicy.isNonGlobal(host) {
            return .block(localRefusal)
        }
        let onion = host.hasSuffix(".onion") || host.hasSuffix(".onion.")
        if scheme == "http" {
            if onion && settings.allowOnionHTTP {
                return .allow(url)
            }
            if settings.httpsOnly && !onion {
                components.scheme = "https"
                guard let upgraded = components.url else { return .block(schemeRefusal) }
                return .allow(upgraded)
            }
            return .block(schemeRefusal)
        }
        return .allow(url)
    }
}

enum HostPolicy {
    static func isNonGlobal(_ host: String) -> Bool {
        let trimmed = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
        if trimmed.isEmpty { return true }
        if trimmed == "localhost" || trimmed.hasSuffix(".localhost") || trimmed.hasSuffix(".local") || trimmed.hasSuffix(".localdomain") {
            return true
        }
        if trimmed == "::1" || trimmed == "0:0:0:0:0:0:0:1" { return true }
        if trimmed.hasPrefix("fe80:") || trimmed.hasPrefix("fc") || trimmed.hasPrefix("fd") { return true }
        if let mapped = ipv4Mapped(trimmed), isNonGlobalIPv4(mapped) { return true }
        if let ipv4 = parseIPv4(trimmed) { return isNonGlobalIPv4(ipv4) }
        return false
    }

    private static func ipv4Mapped(_ host: String) -> [Int]? {
        let prefix = "::ffff:"
        guard host.hasPrefix(prefix) else { return nil }
        return parseIPv4(String(host.dropFirst(prefix.count)))
    }

    /// Four decimal octets, or `[]` when a leading zero makes the address
    /// ambiguous (those are refused). `nil` means this is not an IPv4 address.
    static func parseIPv4(_ host: String) -> [Int]? {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        var octets: [Int] = []
        var ambiguous = false
        for part in parts {
            guard !part.isEmpty, part.allSatisfy(\.isNumber), let value = Int(part), (0...255).contains(value) else {
                return nil
            }
            if part.count > 1, part.hasPrefix("0") { ambiguous = true }
            octets.append(value)
        }
        return ambiguous ? [] : octets
    }

    private static func isNonGlobalIPv4(_ octets: [Int]) -> Bool {
        if octets.isEmpty { return true }
        guard octets.count == 4 else { return true }
        let a = octets[0], b = octets[1]
        if a == 0 || a == 10 || a == 127 { return true }
        if a == 169 && b == 254 { return true }
        if a == 172 && (16...31).contains(b) { return true }
        if a == 192 && b == 168 { return true }
        if a >= 224 { return true }
        return false
    }
}

enum VeilSearch {
    static let duckDuckGoOnion: URL = {
        guard let url = URL(string: "https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/") else {
            preconditionFailure("DuckDuckGo onion address is not a URL")
        }
        return url
    }()

    static func query(_ text: String) -> URL {
        var components = URLComponents(url: duckDuckGoOnion, resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "q", value: text)]
        return components?.url ?? duckDuckGoOnion
    }
}

enum AddressInterpreter {
    static func decide(_ raw: String, registry: AppRegistry, settings: VeilSettings) -> AddressOutcome {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return .empty }
        if let command = AppCommands.parse(text) {
            return .command(command)
        }
        if text.range(of: #"^[a-z][a-z0-9+.-]*:"#, options: [.regularExpression, .caseInsensitive]) != nil {
            if let url = directURL(text) {
                return outcome(for: url, settings: settings)
            }
            return .search(VeilSearch.query(text))
        }
        if let hostURL = hostURL(text) {
            return outcome(for: hostURL, settings: settings)
        }
        return .search(VeilSearch.query(text))
    }

    private static func outcome(for url: URL, settings: VeilSettings) -> AddressOutcome {
        switch NavigationPolicy.classify(url, settings: settings) {
        case .allow(let allowed): return .navigate(allowed)
        case .block(let reason): return .blocked(reason)
        }
    }

    static func looksLikeAddress(_ text: String) -> Bool {
        if text.range(of: #"^[a-z][a-z0-9+.-]*://"#, options: [.regularExpression, .caseInsensitive]) != nil {
            return true
        }
        if text.hasPrefix("@") { return false }
        return text.range(of: #"^[^\s]+\.[^\s]{2,}$"#, options: .regularExpression) != nil
    }

    private static func directURL(_ text: String) -> URL? {
        guard text.range(of: #"^[a-z][a-z0-9+.-]*:"#, options: [.regularExpression, .caseInsensitive]) != nil else {
            return nil
        }
        guard text.range(of: #"^https?://"#, options: [.regularExpression, .caseInsensitive]) != nil else {
            return nil
        }
        return URL(string: text)
    }

    private static func hostURL(_ text: String) -> URL? {
        guard !text.contains("@"), !text.contains("\\"), !text.hasPrefix("//") else { return nil }
        guard text.range(of: #"^[^\s/]+\.[^\s]{2,}"#, options: .regularExpression) != nil else { return nil }
        guard !text.contains(" ") else { return nil }
        return URL(string: "https://\(text)")
    }
}

struct AddressSuggestion: Identifiable, Equatable {
    enum Kind: Equatable {
        case command(AppCommands.Command)
        case complete(String)
        case open(URL)
        case search(URL)
        case blocked(String)
    }

    var icon: String
    var title: String
    var hint: String
    var kind: Kind
    var isCommand: Bool

    var id: String { "\(icon)|\(title)|\(hint)" }
}

enum AddressSuggestions {
    static func rows(for raw: String, registry: AppRegistry, settings: VeilSettings) -> [AddressSuggestion] {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return [] }
        var rows: [AddressSuggestion] = []
        if let suggestion = AppCommands.suggestion(for: text, registry: registry), let command = AppCommands.parse(text) {
            let icon = command.id == "cndctr" ? "C" : "S"
            rows.append(AddressSuggestion(icon: icon, title: suggestion.label, hint: "Opens in side panel", kind: .command(command), isCommand: true))
        } else if text.hasPrefix("@") {
            let typed = text.dropFirst().split(whereSeparator: \.isWhitespace).first.map { String($0).lowercased() } ?? ""
            for entry in AppCommands.ordered {
                guard registry.app(id: entry.id) != nil, let word = entry.words.first(where: { $0.hasPrefix(typed) }) else { continue }
                let name = registry.app(id: entry.id)?.name ?? entry.id
                let verb = AppCommands.verbs[entry.id] ?? "Open"
                rows.append(AddressSuggestion(
                    icon: entry.id == "cndctr" ? "C" : "S",
                    title: "@\(word)",
                    hint: "\(verb) \(name)",
                    kind: .complete("@\(word) "),
                    isCommand: true
                ))
            }
        }
        if rows.isEmpty || rows[0].isCommand == false {
            let outcome = AddressInterpreter.decide(text, registry: registry, settings: settings)
            switch outcome {
            case .navigate(let url):
                rows.append(AddressSuggestion(icon: "↗", title: url.absoluteString, hint: "Open", kind: .open(url), isCommand: false))
                rows.append(searchRow(text))
            case .search(let url):
                rows.append(AddressSuggestion(icon: "⌕", title: "Search for “\(text)”", hint: "DuckDuckGo", kind: .search(url), isCommand: false))
            case .blocked(let reason):
                rows.append(AddressSuggestion(icon: "·", title: reason, hint: "Blocked", kind: .blocked(reason), isCommand: false))
            case .empty, .command:
                break
            }
        }
        return rows
    }

    private static func searchRow(_ text: String) -> AddressSuggestion {
        AddressSuggestion(
            icon: "⌕",
            title: "Search for “\(text)”",
            hint: "DuckDuckGo",
            kind: .search(VeilSearch.query(text)),
            isCommand: false
        )
    }
}
