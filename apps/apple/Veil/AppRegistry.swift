import Foundation

struct WebLink: Equatable {
    var label: String
    var url: URL
}

struct RegistryApp: Identifiable, Equatable {
    var id: String
    var name: String
    var summary: String
    var url: URL
    var panel: Bool
    var footer: Bool
}

/// The signed app list shipped with VEIL. Addresses come from this list,
/// never from the page or from whatever the user typed.
struct AppRegistry: Equatable {
    var signIn: WebLink?
    var mail: WebLink?
    var apps: [RegistryApp]

    static let empty = AppRegistry(signIn: nil, mail: nil, apps: [])

    static func load(data: Data) throws -> AppRegistry {
        let object = try JSONSerialization.jsonObject(with: data)
        guard let root = object as? [String: Any] else {
            throw RegistryError.malformed
        }
        let signIn = try link(root["signin"], fallback: VeilCopy.signIn)
        let mail = try link(root["mail"], fallback: VeilCopy.mail)
        let rawApps = root["apps"] as? [Any] ?? []
        var apps: [RegistryApp] = []
        for item in rawApps {
            guard let app = item as? [String: Any] else { throw RegistryError.malformed }
            guard let id = string(app["id"]), let name = string(app["name"]),
                  let summary = string(app["summary"]), let urlString = string(app["url"]),
                  let url = URL(string: urlString), isAllowedPageURL(url) else {
                continue
            }
            apps.append(RegistryApp(
                id: id,
                name: name,
                summary: summary,
                url: url,
                panel: app["panel"] as? Bool == true,
                footer: app["footer"] as? Bool == true
            ))
        }
        apps.sort { sortKey($0.name) < sortKey($1.name) }
        return AppRegistry(signIn: signIn, mail: mail, apps: apps)
    }

    static func loadBundled(bundle: Bundle = .main) -> AppRegistry {
        let candidates = [bundle] + Bundle.allBundles
        for candidate in candidates {
            guard let url = candidate.url(forResource: "registry", withExtension: "json"),
                  let data = try? Data(contentsOf: url),
                  let registry = try? load(data: data) else { continue }
            return registry
        }
        return .empty
    }

    func app(id: String) -> RegistryApp? {
        apps.first { $0.id == id }
    }

    /// Same rule as `veil-chrome/src/home/home.js`: letters and digits only,
    /// so marks sort as if they were not there, and Æ sorts as AE.
    static func sortKey(_ name: String) -> String {
        let mapped = name.replacingOccurrences(of: "Æ", with: "AE").replacingOccurrences(of: "æ", with: "ae")
        let folded = mapped.decomposedStringWithCompatibilityMapping
        let scalars = folded.unicodeScalars.filter { scalar in
            (48...57).contains(scalar.value) || (65...90).contains(scalar.value) || (97...122).contains(scalar.value)
        }
        return String(String.UnicodeScalarView(scalars)).lowercased()
    }

    static func isAllowedPageURL(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https" else { return false }
        guard url.user == nil, url.password == nil else { return false }
        guard let host = url.host, !host.isEmpty, !host.contains(" ") else { return false }
        return true
    }

    private static func link(_ value: Any?, fallback: String) throws -> WebLink? {
        guard let value else { return nil }
        guard let object = value as? [String: Any] else { throw RegistryError.malformed }
        guard let urlString = string(object["url"]), let url = URL(string: urlString), isAllowedPageURL(url) else {
            return nil
        }
        let label = string(object["label"]) ?? fallback
        return WebLink(label: label, url: url)
    }

    private static func string(_ value: Any?) -> String? {
        guard let text = value as? String else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

enum RegistryError: Error, Equatable {
    case malformed
}
