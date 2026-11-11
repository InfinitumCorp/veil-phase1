import Foundation

public enum LoopbackHost {
    public static func isLoopback(_ host: String) -> Bool {
        let value = host.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
            .lowercased()
        return value == "127.0.0.1" || value == "localhost" || value == "::1"
    }
}
