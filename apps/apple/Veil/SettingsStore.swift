import Foundation

struct VeilSettings: Equatable, Codable {
    var schema: Int
    var wipeOnClose: Bool
    var httpsOnly: Bool
    var allowOnionHTTP: Bool
    var tor: TorLaunchConfiguration

    static let veilDefault = VeilSettings(
        schema: 1,
        wipeOnClose: true,
        httpsOnly: true,
        allowOnionHTTP: true,
        tor: .veilDefault
    )

    init(schema: Int = 1, wipeOnClose: Bool, httpsOnly: Bool, allowOnionHTTP: Bool, tor: TorLaunchConfiguration) {
        self.schema = schema
        self.wipeOnClose = wipeOnClose
        self.httpsOnly = httpsOnly
        self.allowOnionHTTP = allowOnionHTTP
        self.tor = tor
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schema = try container.decodeIfPresent(Int.self, forKey: .schema) ?? 1
        wipeOnClose = try container.decodeIfPresent(Bool.self, forKey: .wipeOnClose) ?? true
        httpsOnly = try container.decodeIfPresent(Bool.self, forKey: .httpsOnly) ?? true
        allowOnionHTTP = try container.decodeIfPresent(Bool.self, forKey: .allowOnionHTTP) ?? true
        tor = try container.decodeIfPresent(TorLaunchConfiguration.self, forKey: .tor) ?? .veilDefault
    }
}

protocol KeyValueStoring: AnyObject {
    func data(forKey key: String) -> Data?
    func set(_ data: Data?, forKey key: String)
}

final class MemoryKeyValueStore: KeyValueStoring {
    var values: [String: Data] = [:]
    func data(forKey key: String) -> Data? { values[key] }
    func set(_ data: Data?, forKey key: String) { values[key] = data }
}

final class UserDefaultsStore: KeyValueStoring {
    private let defaults: UserDefaults
    init(defaults: UserDefaults) { self.defaults = defaults }
    func data(forKey key: String) -> Data? { defaults.data(forKey: key) }
    func set(_ data: Data?, forKey key: String) { defaults.set(data, forKey: key) }
}

final class SettingsStore {
    static let storageKey = "veil.settings"
    private let store: KeyValueStoring

    init(store: KeyValueStoring) {
        self.store = store
    }

    func load() -> VeilSettings {
        guard let data = store.data(forKey: Self.storageKey) else { return .veilDefault }
        guard let settings = try? JSONDecoder().decode(VeilSettings.self, from: data) else { return .veilDefault }
        return settings
    }

    func save(_ settings: VeilSettings) {
        guard let data = try? JSONEncoder().encode(settings) else { return }
        store.set(data, forKey: Self.storageKey)
    }
}
